import { o, type OntologyIR, type LiveOntology } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { eq, field, literal, selectField, sub } from "@party-stack/ontology/query";
import { Deferred, Effect, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeOntologyServer } from "./composition.js";
import { connectOntologyHttp, makeOntologyHttpHandler } from "./rpcHttp.js";

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
                { name: "secret", displayName: "Secret", type: o.encrypted({ type: o.timestamp({}) }) },
            ],
        },
    ],
};
const value = {
    ciphertext: "cipher-1",
    source: { objectType: "Person", primaryKey: "1", property: "secret" },
};
const plaintext = "2026-10-23T12:00:00Z";
const setup = Effect.fnUntraced(function* () {
    const decrypt = vi.fn(() => Effect.succeed({ value: plaintext, ciphertext: value.ciphertext }));
    const owned = yield* makeOwnedBackend({
        ir,
        namespace: "encrypted",
        tables: yield* Memory.make(),
        mutators: {},
        encrypted: { decrypt },
    });
    yield* owned.storage.transaction((tx) => tx.put("Person", { id: "1", secret: value }));
    return { owned, decrypt };
});

test("Effect HTTP RPC explicitly authorizes decrypt and preserves plaintext representation without row replication", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { owned, decrypt } = yield* setup();
                let allowed = false;
                const handler = yield* makeOntologyHttpHandler({
                    source: owned.protocol,
                    backend: owned,
                    authorize: (request) =>
                        request.operation !== "Decrypt" || allowed
                            ? Effect.void
                            : Effect.fail(
                                  new BackendError({
                                      operation: "decrypt",
                                      kind: "ValidationFailed",
                                      message: "Forbidden",
                                      retryable: false,
                                  })
                              ),
                });
                const client = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handler(new Request(input, init))
                    )
                );
                expect((yield* Effect.result(client.operations.decrypt(value)))._tag).toBe("Failure");
                expect(decrypt).not.toHaveBeenCalled();
                allowed = true;
                expect(yield* client.operations.decrypt(value)).toBe(plaintext);
                expect(yield* owned.storage.read((tx) => tx.get("Person", "1"))).toEqual({
                    id: "1",
                    secret: value,
                });
            })
        )
    );
});

test("memory clients forward cache policy to their persistent ontology owner", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { owned } = yield* setup();
                const decrypt = vi.fn(async () => Temporal.Instant.from(plaintext));
                const ontology = { ir, decrypt } as unknown as LiveOntology;
                const handler = yield* makeOntologyHttpHandler({
                    source: owned.protocol,
                    ontology,
                    authorize: () => Effect.void,
                });
                const client = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handler(new Request(input, init))
                    )
                );
                expect(yield* client.operations.decrypt(value, { cache: true })).toBe(plaintext);
                expect(decrypt).toHaveBeenCalledWith(
                    value,
                    expect.objectContaining({ cache: true, signal: expect.any(AbortSignal) })
                );
            })
        )
    );
});

test("native policy HTTP requires a readable source row/property and matching ciphertext on every decrypt", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { owned, decrypt } = yield* setup();
                const definition: OntologyIR = {
                    ...ir,
                    policy: {
                        read: {
                            select: [
                                sub("people", {
                                    from: { source: { objectType: "Person" }, binding: "person" },
                                    where: eq(field("person", "id"), literal("1")),
                                    select: ["id", "secret"].map((name) =>
                                        selectField(name, field("person", name))
                                    ),
                                }),
                            ],
                        },
                    },
                };
                const server = yield* makeOntologyServer({
                    kind: "owned",
                    backend: owned,
                    ir: definition,
                    context: {},
                });
                const client = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        server.handleRequest(new Request(input, init))
                    )
                );
                for (const forged of [
                    { ...value, ciphertext: "other" },
                    { ...value, source: { ...value.source, primaryKey: "other" } },
                    { ...value, source: { ...value.source, property: "id" } },
                ]) {
                    expect(yield* client.operations.decrypt(forged).pipe(Effect.flip)).toMatchObject({
                        kind: "NotFound",
                    });
                }
                expect(decrypt).not.toHaveBeenCalled();
                expect(yield* client.operations.decrypt(value)).toBe(plaintext);
                yield* owned.storage.transaction((tx) => tx.delete("Person", "1"));
                expect(yield* client.operations.decrypt(value).pipe(Effect.flip)).toMatchObject({
                    kind: "NotFound",
                });
                expect(decrypt).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test("cancelling decrypt RPC aborts the persistent owner's operation", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { owned } = yield* setup();
                const started = yield* Deferred.make<void>();
                let aborted = false;
                const ontology = {
                    ir,
                    decrypt: (_value: unknown, settings?: { signal?: AbortSignal }) =>
                        new Promise<never>((_resolve, reject) => {
                            settings?.signal?.addEventListener(
                                "abort",
                                () => {
                                    aborted = true;
                                    reject(new Error("aborted"));
                                },
                                { once: true }
                            );
                            Effect.runSync(Deferred.succeed(started, undefined));
                        }),
                } as unknown as LiveOntology;
                const handler = yield* makeOntologyHttpHandler({
                    source: owned.protocol,
                    ontology,
                    authorize: () => Effect.void,
                });
                const client = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handler(new Request(input, init))
                    )
                );
                const pending = yield* Effect.forkChild(client.operations.decrypt(value));
                yield* Deferred.await(started);
                yield* Fiber.interrupt(pending);
                yield* Effect.promise(() => vi.waitFor(() => expect(aborted).toBe(true)));
            })
        )
    );
});
