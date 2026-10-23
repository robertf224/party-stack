import { BackendError } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { TemporalTimestamp } from "@party-stack/ontology-spec/effect";
import { makeBlobStorage } from "@party-stack/ontology-storage/blobs";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime, createDefaultRuntime } from "@party-stack/runtime";
import { queryOnce } from "@tanstack/db";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { createLiveOntology } from "../live/LiveOntology.js";
import { makeStorageOntologyBackend } from "../live/storageBackend.js";
import { makeLiveDecryption } from "./encrypted.js";
import type { Encrypted } from "@party-stack/ontology-spec/values";

const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    queryFunctionTypes: [],
    linkTypes: [],
    objectTypes: [
        {
            name: "Person",
            displayName: "Person",
            pluralDisplayName: "People",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "secret",
                    displayName: "Secret",
                    type: o.encrypted({
                        type: o.struct({
                            fields: [
                                { name: "token", displayName: "Token", type: o.string({}) },
                                { name: "at", displayName: "At", type: o.timestamp({}) },
                            ],
                        }),
                    }),
                },
            ],
        },
    ],
};
const handle = { id: "cipher-1", source: { objectType: "Person", primaryKey: "1", property: "secret" } };
const wire = { token: "private-token-test", at: "2026-10-23T00:00:00Z" };
const decoded = { ...wire, at: Temporal.Instant.from(wire.at) };
const keyring = async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    return { active: Effect.succeed({ id: "device", key }), get: () => Effect.succeed(key) };
};
const fixture = Effect.fnUntraced(function* (settings?: {
    keys?: boolean;
    owner?: string;
    sourceId?: string;
    tables?: Effect.Success<ReturnType<typeof Memory.make>>;
}) {
    const tables = settings?.tables ?? (yield* Memory.make());
    const keys = yield* Effect.promise(keyring);
    const adapter = createDefaultRuntime(settings?.owner ?? "alice", "private");
    const runtime = yield* Runtime.make({
        ...adapter,
        tables: Effect.succeed(tables),
        encryptionKeyring: settings?.keys === false ? undefined : Effect.succeed(keys),
    });
    const call = vi.fn((value: Encrypted) => Effect.succeed({ value: wire, valueId: value.id }));
    const open = (sourceId = settings?.sourceId ?? "authority") =>
        makeLiveDecryption({ ir, backend: { sourceId, encrypted: { decrypt: call } } }).pipe(
            Effect.provideService(Runtime, runtime)
        );
    return { tables, runtime, call, open, service: yield* open() };
});

test("default decrypt bypasses cache; opt-in encrypts a copy, survives reopening, and can be evicted", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { service, call, open, tables, runtime } = yield* fixture();
                expect(yield* service.decrypt(handle)).toEqual(decoded);
                expect(yield* service.decrypt(handle)).toEqual(decoded);
                expect(call).toHaveBeenCalledTimes(2);
                expect(yield* service.decrypt(handle, { cache: true })).toEqual(decoded);
                expect(call).toHaveBeenCalledTimes(3);
                call.mockImplementation(
                    () =>
                        Effect.fail(
                            new BackendError({
                                operation: "offline",
                                kind: "Unavailable",
                                message: "Offline",
                                retryable: true,
                            })
                        ) as never
                );
                const reopened = yield* open();
                expect(yield* reopened.decrypt(handle, { cache: true })).toEqual(decoded);
                expect((yield* Effect.result(reopened.decrypt(handle)))._tag).toBe("Failure");
                const cacheName = JSON.stringify(["decrypted-cache", "alice", "private"]);
                const record = (yield* tables.loadSubset(
                    Table.make<{ local: { id: string } }>({ name: cacheName })
                ))[0]!.value;
                const cipher = yield* makeEncryptedValues(
                    cacheName,
                    tables,
                    runtime.encryptionKeyring!
                ).ciphertext(record.local);
                expect(JSON.stringify(cipher)).not.toContain(wire.token);
                yield* reopened.evict(handle);
                expect(yield* tables.loadSubset(Table.make({ name: cacheName }))).toEqual([]);
                expect(
                    yield* makeEncryptedValues(cacheName, tables, runtime.encryptionKeyring!).ciphertext(
                        record.local
                    )
                ).toBeUndefined();
                expect((yield* Effect.result(reopened.decrypt(handle, { cache: true })))._tag).toBe(
                    "Failure"
                );
            })
        )
    );
});

test("cache requires keys and separates source, principal, property, and encrypted value identities", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const first = yield* fixture();
                yield* first.service.decrypt(handle, { cache: true });
                const otherSource = yield* first.open("other-authority");
                yield* otherSource.decrypt(handle, { cache: true });
                yield* first.service.decrypt({ ...handle, id: "cipher-2" }, { cache: true });
                expect(first.call).toHaveBeenCalledTimes(3);
                const otherUser = yield* fixture({ owner: "bob", tables: first.tables });
                yield* otherUser.service.decrypt(handle, { cache: true });
                expect(otherUser.call).toHaveBeenCalledTimes(1);
                const noKeys = yield* fixture({ keys: false });
                expect(yield* noKeys.service.decrypt(handle)).toEqual(decoded);
                expect(
                    yield* noKeys.service.decrypt(handle, { cache: true }).pipe(Effect.flip)
                ).toMatchObject({ kind: "Unsupported" });
                expect(noKeys.call).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test("unbound current-property responses are never cached; conflicting identity is rejected", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { service, call } = yield* fixture();
                call.mockImplementation(() => Effect.succeed({ value: wire }) as never);
                yield* service.decrypt(handle, { cache: true });
                yield* service.decrypt(handle, { cache: true });
                expect(call).toHaveBeenCalledTimes(2);
                call.mockImplementation(() => Effect.succeed({ value: wire, valueId: "newer-cipher" }));
                expect(yield* service.decrypt(handle, { cache: true }).pipe(Effect.flip)).toMatchObject({
                    kind: "Conflict",
                });
            })
        )
    );
});

test("rejects invalid sources and redacts schema errors and provider bodies", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { service, call } = yield* fixture();
                expect((yield* Effect.result(service.decrypt({ id: "missing-source" })))._tag).toBe(
                    "Failure"
                );
                expect(
                    (yield* Effect.result(
                        service.decrypt({ ...handle, source: { ...handle.source, property: "id" } })
                    ))._tag
                ).toBe("Failure");
                expect(call).not.toHaveBeenCalled();
                call.mockImplementation(
                    () =>
                        Effect.succeed({
                            value: { token: wire.token, at: wire.token },
                            valueId: handle.id,
                        }) as never
                );
                expect(JSON.stringify(yield* service.decrypt(handle).pipe(Effect.flip))).not.toContain(
                    wire.token
                );
                call.mockImplementation(
                    () =>
                        Effect.fail(
                            new BackendError({
                                operation: "provider",
                                kind: "Rejected",
                                retryable: false,
                                message: wire.token,
                                cause: wire.token,
                            })
                        ) as never
                );
                expect(JSON.stringify(yield* service.decrypt(handle).pipe(Effect.flip))).not.toContain(
                    wire.token
                );
            })
        )
    );
});

test("interrupting remote decryption cannot leave a cache entry", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { service, call } = yield* fixture();
                const started = yield* Deferred.make<void>();
                let stopped = false;
                call.mockImplementation(
                    () =>
                        Deferred.succeed(started, undefined).pipe(
                            Effect.andThen(Effect.never),
                            Effect.ensuring(
                                Effect.sync(() => {
                                    stopped = true;
                                })
                            )
                        ) as never
                );
                const fiber = yield* Effect.forkChild(service.decrypt(handle, { cache: true }));
                yield* Deferred.await(started);
                yield* Fiber.interrupt(fiber);
                expect(stopped).toBe(true);
                call.mockImplementation((value) => Effect.succeed({ value: wire, valueId: value.id }));
                yield* service.decrypt(handle, { cache: true });
                expect(call).toHaveBeenCalledTimes(2);
            })
        )
    );
});

test("LiveOntology decorates native encrypted handles and only decrypts on an explicit call", async () => {
    const call = vi.fn(() => Effect.succeed({ value: wire, valueId: handle.id }));
    const live = await createLiveOntology({
        ir,
        backend: () => ({
            name: "test",
            open: () =>
                Effect.succeed({
                    name: "test",
                    sourceId: "authority",
                    supportsIdempotency: false,
                    loadSubset: () =>
                        Effect.succeed({
                            rows: [{ key: "1", value: { id: "1", secret: { id: handle.id } } }],
                            complete: true,
                        }),
                    invoke: () => Effect.die("unused"),
                    queryFunction: () => Effect.die("unused"),
                    encrypted: { decrypt: call },
                }),
        }),
    });
    try {
        const rows = await queryOnce((q) => q.from({ person: live.objects.Person! }));
        expect(call).not.toHaveBeenCalled();
        expect(rows[0]!.secret).toEqual(handle);
        expect(await live.decrypt(rows[0]!.secret as typeof handle)).toEqual(decoded);
        expect(call).toHaveBeenCalledTimes(1);
    } finally {
        await live.cleanup();
    }
});

test("cache ciphertext authenticates its value binding even if the mapping is transplanted", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { tables, service, call } = yield* fixture();
                yield* service.decrypt(handle, { cache: true });
                const table = Table.make<{ valueId: string; local: Encrypted }>({
                    name: JSON.stringify(["decrypted-cache", "alice", "private"]),
                });
                const entry = (yield* tables.loadSubset(table))[0]!;
                yield* tables.put(table, entry.key, { ...entry.value, valueId: "cipher-2" });
                call.mockImplementation(() =>
                    Effect.succeed({ value: { ...wire, token: "new-value" }, valueId: "cipher-2" })
                );
                expect(yield* service.decrypt({ ...handle, id: "cipher-2" }, { cache: true })).toMatchObject({
                    token: "new-value",
                });
                expect(call).toHaveBeenCalledTimes(2);
            })
        )
    );
});

test("owned storage decrypts with deployment keys and proves an immutable handle identity", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const keys = yield* Effect.promise(keyring);
                const namespace = "authority";
                const blobs = yield* makeBlobStorage({
                    namespace,
                    tables,
                    mode: "authoritative",
                    bytes: {
                        read: () => Effect.succeed(undefined),
                        write: () => Effect.void,
                        delete: () => Effect.void,
                    },
                });
                const owned = yield* makeStorageOntologyBackend({
                    ir,
                    namespace,
                    tables,
                    blobs,
                    encryptionKeyring: keys,
                });
                const values = makeEncryptedValues(namespace, tables, keys);
                const schema = Schema.Struct({ token: Schema.String, at: TemporalTimestamp });
                const encrypted = yield* values.encrypt(schema, decoded);
                const target = { ...encrypted, source: handle.source };
                yield* owned.storage.transaction((tx) => tx.put("Person", { id: "1", secret: encrypted }));
                expect(yield* owned.encrypted!.decrypt(target)).toEqual({
                    value: wire,
                    valueId: encrypted.id,
                });
                const next = yield* values.encrypt(schema, { ...decoded, token: "rotated" });
                yield* owned.storage.transaction((tx) => tx.put("Person", { id: "1", secret: next }));
                expect(yield* owned.encrypted!.decrypt(target).pipe(Effect.flip)).toMatchObject({
                    kind: "Conflict",
                });
                const page = yield* owned.changes!.pull({});
                expect(JSON.stringify(page)).not.toContain(wire.token);
            })
        )
    );
});
