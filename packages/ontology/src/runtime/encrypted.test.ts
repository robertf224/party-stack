import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica } from "@party-stack/ontology-replica";
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
const handle = {
    ciphertext: "cipher-1",
    source: { objectType: "Person", primaryKey: "1", property: "secret" },
};
const wire = { token: "private-token-test", at: "2026-10-23T00:00:00Z" };
const decoded = { ...wire, at: Temporal.Instant.from(wire.at) };
const keyring = async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    return { active: Effect.succeed({ id: "device", key }), get: () => Effect.succeed(key) };
};
const fixture = Effect.fnUntraced(function* (settings?: { keys?: boolean; owner?: string }) {
    const tables = yield* Memory.make();
    const keys = yield* Effect.promise(keyring);
    const owner = settings?.owner ?? "alice";
    const runtime = yield* Runtime.make({
        ...createDefaultRuntime(owner, "private"),
        tables: Effect.succeed(tables),
        encryptionKeyring: settings?.keys === false ? undefined : Effect.succeed(keys),
    });
    const call = vi.fn((value: Encrypted) => Effect.succeed({ value: wire, ciphertext: value.ciphertext }));
    const backend = {
        name: "test",
        sourceId: "authority",
        supportsIdempotency: false,
        loadSubset: () =>
            Effect.succeed({ rows: [{ key: "1", value: { id: "1", secret: handle } }], complete: true }),
        invoke: () => Effect.die("unused"),
        queryFunction: () => Effect.die("unused"),
        encrypted: { decrypt: call },
        pollIntervalMs: () => false as const,
    };
    const replica = yield* makeReplica({
        namespace: "private",
        ir,
        tables,
        backend,
        startSync: false,
        execute: () => Effect.void,
    });
    // Load, then release demand so the row can later be collected.
    yield* Effect.scoped(replica.demand({ objectType: "Person" }).pipe(Effect.andThen(replica.syncOnce)));
    const open = (sourceId = "authority") =>
        makeLiveDecryption({ ir, replica, backend: { sourceId, encrypted: backend.encrypted } }).pipe(
            Effect.provideService(Runtime, runtime)
        );
    const raw = Table.make<{ id: string; secret: Encrypted & { localCache?: Encrypted } }>({
        name: JSON.stringify(["replica", "private", "base:Person"]),
    });
    return { tables, runtime, call, replica, open, raw, service: yield* open() };
});

test("cache is an encrypted row property, survives reopening, stays out of replication and follows row GC", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { service, call, open, tables, raw, replica } = yield* fixture();
                expect(yield* service.decrypt(handle)).toEqual(decoded);
                expect(yield* service.decrypt(handle)).toEqual(decoded);
                expect(call).toHaveBeenCalledTimes(2);
                yield* service.decrypt(handle, { cache: true });
                const row = (yield* tables.get(raw, "1"))!;
                expect(row.secret.ciphertext).toBe(handle.ciphertext);
                expect(row.secret.localCache?.ciphertext).toContain("party-stack:encrypted:v1:");
                expect(JSON.stringify(row)).not.toContain(wire.token);
                const exported = yield* replica.snapshotState;
                expect(JSON.stringify(exported)).not.toContain("localCache");
                expect(JSON.stringify(structuredClone(exported))).not.toContain("party-stack:encrypted:v1:");
                const reopened = yield* open();
                expect(yield* reopened.decrypt(handle, { cache: true })).toEqual(decoded);
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
                expect((yield* Effect.result(reopened.decrypt(handle)))._tag).toBe("Failure");
                expect(yield* replica.collectGarbage({ olderThanMs: 0 })).toBe(1);
                expect(yield* tables.get(raw, "1")).toBeUndefined();
                expect(yield* replica.encryptedCache.get(handle)).toBeUndefined();
                expect((yield* Effect.result(reopened.decrypt(handle, { cache: true })))._tag).toBe(
                    "Failure"
                );
            })
        )
    );
});

test("cache requires keys and authenticates its authority, principal, property and original ciphertext", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                yield* f.service.decrypt(handle, { cache: true });
                yield* (yield* f.open("other-authority")).decrypt(handle, { cache: true });
                expect(f.call).toHaveBeenCalledTimes(2);
                const local = (yield* f.tables.get(f.raw, "1"))!.secret.localCache!;
                yield* f.tables.put(f.raw, "1", {
                    id: "1",
                    secret: { ...handle, ciphertext: "cipher-2", localCache: local },
                });
                expect(
                    yield* f.service.decrypt({ ...handle, ciphertext: "cipher-2" }, { cache: true })
                ).toEqual(decoded);
                expect(f.call).toHaveBeenCalledTimes(3);
                const noKeys = yield* fixture({ keys: false });
                expect(yield* noKeys.service.decrypt(handle)).toEqual(decoded);
                expect(
                    yield* noKeys.service.decrypt(handle, { cache: true }).pipe(Effect.flip)
                ).toMatchObject({ kind: "Unsupported" });
                // Same authority/property, copied bytes, different identity partition and device key.
                const other = yield* fixture({ owner: "bob" });
                yield* other.tables.put(other.raw, "1", (yield* f.tables.get(f.raw, "1"))!);
                yield* other.service.decrypt({ ...handle, ciphertext: "cipher-2" }, { cache: true });
                expect(other.call).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test("unbound responses never cache; contradictory ciphertext is rejected and errors exclude secrets", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { service, call, tables, raw } = yield* fixture();
                call.mockImplementation(() => Effect.succeed({ value: wire }) as never);
                yield* service.decrypt(handle, { cache: true });
                expect((yield* tables.get(raw, "1"))!.secret.localCache).toBeUndefined();
                call.mockImplementation(() => Effect.succeed({ value: wire, ciphertext: "newer" }));
                expect(yield* service.decrypt(handle).pipe(Effect.flip)).toMatchObject({ kind: "Conflict" });
                expect((yield* Effect.result(service.decrypt({ ciphertext: "missing-source" })))._tag).toBe(
                    "Failure"
                );
                call.mockImplementation(() =>
                    Effect.succeed({
                        value: { token: wire.token, at: wire.token },
                        ciphertext: handle.ciphertext,
                    })
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
                                message: wire.token,
                                cause: wire.token,
                                retryable: false,
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

test("a late remote response cannot recreate an evicted row or attach a cache to changed ciphertext", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                for (const remove of [false, true]) {
                    const f = yield* fixture();
                    const started = yield* Deferred.make<void>();
                    const reply = yield* Deferred.make<{ value: typeof wire; ciphertext: string }>();
                    f.call.mockImplementation(() =>
                        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply)))
                    );
                    const fiber = yield* Effect.forkChild(f.service.decrypt(handle, { cache: true }));
                    yield* Deferred.await(started);
                    if (remove) yield* f.replica.collectGarbage({ olderThanMs: 0 });
                    else yield* f.tables.put(f.raw, "1", { id: "1", secret: { ciphertext: "newer" } });
                    yield* Deferred.succeed(reply, { value: wire, ciphertext: handle.ciphertext });
                    expect(yield* Fiber.join(fiber)).toEqual(decoded);
                    const row = yield* f.tables.get(f.raw, "1");
                    expect(row?.secret.localCache).toBeUndefined();
                    if (remove) expect(row).toBeUndefined();
                    else expect(row?.secret.ciphertext).toBe("newer");
                }
            })
        )
    );
});

test("interrupting remote decryption cannot cache a value", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const started = yield* Deferred.make<void>();
                let stopped = false;
                f.call.mockImplementation(
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
                const fiber = yield* Effect.forkChild(f.service.decrypt(handle, { cache: true }));
                yield* Deferred.await(started);
                yield* Fiber.interrupt(fiber);
                expect(stopped).toBe(true);
                expect((yield* f.tables.get(f.raw, "1"))!.secret.localCache).toBeUndefined();
            })
        )
    );
});

test("LiveOntology decorates encrypted sources and only decrypts explicitly", async () => {
    const call = vi.fn(() => Effect.succeed({ value: wire, ciphertext: handle.ciphertext }));
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
                            rows: [
                                { key: "1", value: { id: "1", secret: { ciphertext: handle.ciphertext } } },
                            ],
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
    } finally {
        await live.cleanup();
    }
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
                const values = makeEncryptedValues(namespace, keys);
                const schema = Schema.Struct({ token: Schema.String, at: TemporalTimestamp });
                const encrypted = yield* values.encrypt(schema, decoded);
                const target = { ...encrypted, source: handle.source };
                yield* owned.storage.transaction((tx) => tx.put("Person", { id: "1", secret: encrypted }));
                expect(yield* owned.encrypted!.decrypt(target)).toEqual({
                    value: wire,
                    ciphertext: encrypted.ciphertext,
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

test("journal refresh preserves the device copy only while the authoritative ciphertext matches", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const definition = {
                    ...ir,
                    objectTypes: [
                        {
                            ...ir.objectTypes[0]!,
                            properties: [
                                ...ir.objectTypes[0]!.properties,
                                { name: "title", displayName: "Title", type: o.string({}) },
                            ],
                        },
                    ],
                };
                const server = yield* makeOwnedBackend({
                    namespace: "authority",
                    ir: definition,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                yield* server.storage.transaction((tx) =>
                    tx.put("Person", { id: "1", secret: handle, title: "first" })
                );
                const tables = yield* Memory.make();
                const replica = yield* makeReplica({
                    namespace: "local",
                    ir: definition,
                    tables,
                    backend: server,
                    execute: () => Effect.void,
                    startSync: false,
                });
                yield* replica.syncOnce;
                const local = { ciphertext: "device-encrypted-copy" };
                yield* replica.encryptedCache.put(handle, local);
                yield* server.storage.transaction((tx) =>
                    tx.put("Person", { id: "1", secret: handle, title: "updated" })
                );
                yield* replica.syncOnce;
                expect((yield* replica.get("Person", "1"))?.title).toBe("updated");
                expect(yield* replica.encryptedCache.get(handle)).toEqual(local);
                const rotated = { ...handle, ciphertext: "rotated" };
                yield* server.storage.transaction((tx) =>
                    tx.put("Person", { id: "1", secret: rotated, title: "updated" })
                );
                yield* replica.syncOnce;
                expect(yield* replica.encryptedCache.get(handle)).toBeUndefined();
                expect(yield* replica.encryptedCache.get(rotated)).toBeUndefined();
            })
        )
    );
});
