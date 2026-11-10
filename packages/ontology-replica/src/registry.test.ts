import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { TemporalTimestamp } from "@party-stack/ontology-spec/effect";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import {
    MemoryBlobBytesStore,
    MemoryRuntime,
    Runtime,
    RuntimePartition,
    Runtimes,
} from "@party-stack/runtime";
import { Effect, Layer, Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeReplicaPartitionCatalog, makeReplicaRegistry } from "./registry.js";
import type { StoredReplicaPartition } from "./registry.js";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";

const ir = { types: [], objectTypes: [], linkTypes: [], actionTypes: [], queryFunctionTypes: [] };
test("registry shares scoped replicas and can forget a stored partition after credentials expire", async () => {
    const resolved = vi.fn();
    const destroyed: string[] = [];
    let authenticated = true;
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const partition = yield* RuntimePartition;
            return yield* Runtime.make({
                tables: yield* Memory.make(),
                blobBytes: new MemoryBlobBytesStore(),
                destroy: Effect.sync(() => {
                    destroyed.push(partition.namespace);
                }),
            });
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "owned",
                    mutators: {},
                });
                const registry = yield* makeReplicaRegistry({
                    idleRetentionMs: 0,
                    resolve: () =>
                        Effect.suspend(() => {
                            resolved();
                            return authenticated
                                ? Effect.succeed({ ir, context: {}, backend, namespace: "cached-issues" })
                                : Effect.fail(
                                      new BackendError({
                                          operation: "resolve",
                                          kind: "Unauthenticated",
                                          retryable: false,
                                          message: "Expired",
                                      })
                                  );
                        }),
                });
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const first = yield* registry.acquire("issues");
                        const second = yield* registry.acquire("issues");
                        expect(first).toBe(second);
                    })
                );
                expect(resolved).toHaveBeenCalledTimes(1);
                authenticated = false;
                yield* registry.forget("issues");
                expect(resolved).toHaveBeenCalledTimes(1);
                expect(destroyed).toEqual(["cached-issues"]);
                expect(yield* registry.partitions).toEqual([]);
            }).pipe(Effect.provide(Runtimes.layer(platform)))
        )
    );
});

test("registry rejects two simultaneous replica owners for the same persistent partition", async () => {
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            return yield* Runtime.make({
                tables: yield* Memory.make(),
                blobBytes: new MemoryBlobBytesStore(),
            });
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "owned",
                    mutators: {},
                });
                const registry = yield* makeReplicaRegistry({
                    resolve: () => Effect.succeed({ ir, backend, namespace: "same-partition" }),
                });
                yield* registry.acquire("first-name");
                expect(yield* Effect.result(registry.acquire("second-name"))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidConfiguration" },
                });
            }).pipe(Effect.provide(Runtimes.layer(platform)))
        )
    );
});

test("default registry preserves existing data namespaces and leaves legacy catalogs untouched", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const runtimes = yield* Runtimes;
                const legacyCatalog = yield* runtimes.acquire({
                    owner: "replica-registry",
                    namespace: "old-notes-id",
                });
                const inventory = Table.make<StoredReplicaPartition>({ name: "replica-partitions" });
                const stored = {
                    ontology: "notes",
                    partition: { owner: "anonymous", namespace: "notes-v1" },
                };
                yield* legacyCatalog.tables.put(inventory, "notes", stored);
                const cached = yield* runtimes.acquire(stored.partition);
                const marker = Table.make<string>({ name: "existing-data" });
                yield* cached.tables.put(marker, "saved", "preserved");
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "owned",
                    mutators: {},
                });
                const registry = yield* makeReplicaRegistry({
                    resolve: () => Effect.succeed({ ir, backend, namespace: "notes-v1", live: false }),
                });
                expect(yield* registry.partitions).toEqual([]);
                const current = yield* registry.acquire("notes");
                expect(current.runtime).toBe(cached);
                expect(yield* current.runtime.tables.get(marker, "saved")).toBe("preserved");
                expect(yield* registry.partitions).toEqual([{ ...stored, definition: { ir, context: {} } }]);
                expect(yield* legacyCatalog.tables.get(inventory, "notes")).toEqual(stored);
                const defaultCatalog = yield* runtimes.acquire({
                    owner: "replica-registry",
                    namespace: "default",
                });
                expect(yield* defaultCatalog.tables.get(inventory, "notes")).toMatchObject(stored);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("explicit scopes isolate catalog and default or overridden data namespaces", async () => {
    const opened: RuntimePartition["Service"][] = [];
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            opened.push(yield* RuntimePartition);
            return yield* MemoryRuntime.make();
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "owned",
                    mutators: {},
                });
                const first = yield* makeReplicaRegistry({
                    scope: "a:b",
                    resolve: (ontology) =>
                        Effect.succeed({
                            ir,
                            backend,
                            live: false,
                            namespace: ontology === "overridden" ? "shared" : undefined,
                        }),
                });
                const second = yield* makeReplicaRegistry({
                    scope: "a",
                    resolve: () => Effect.succeed({ ir, backend, namespace: "b:shared", live: false }),
                });
                const one = yield* first.acquire("overridden");
                expect(one.runtime.namespace).toBe(JSON.stringify(["replica-scope", "a:b", "shared"]));
                expect(yield* second.partitions).toEqual([]);
                const two = yield* second.acquire("overridden");
                expect(two.runtime.namespace).toBe(JSON.stringify(["replica-scope", "a", "b:shared"]));
                expect(one.runtime.owner).toBe(two.runtime.owner);
                const marker = Table.make<string>({ name: "scoped-data" });
                yield* one.runtime.tables.put(marker, "key", "first only");
                expect(yield* two.runtime.tables.get(marker, "key")).toBeUndefined();
                const fallback = yield* first.acquire("defaulted");
                expect(fallback.runtime.namespace).toBe(
                    JSON.stringify(["replica-scope", "a:b", "defaulted"])
                );
                expect((yield* first.partitions).map((entry) => entry.ontology).sort()).toEqual([
                    "defaulted",
                    "overridden",
                ]);
                expect((yield* second.partitions).map((entry) => entry.ontology)).toEqual(["overridden"]);
                expect(
                    opened
                        .filter((partition) => partition.owner === "replica-registry")
                        .map((p) => p.namespace)
                ).toEqual([JSON.stringify(["replica-scope", "a:b"]), JSON.stringify(["replica-scope", "a"])]);
            }).pipe(Effect.provide(Runtimes.layer(platform)))
        )
    );
});

test("registry and catalog reject an explicitly empty scope", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                expect(yield* Effect.result(makeReplicaPartitionCatalog(""))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "InvalidConfiguration" },
                });
                expect(
                    yield* Effect.result(
                        makeReplicaRegistry({
                            scope: "",
                            resolve: () => Effect.die("Invalid configuration must not resolve a replica"),
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("catalog retains a portable accepted bootstrap before the next replica opens and removes it on forget", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    ir,
                    tables: yield* Memory.make(),
                    namespace: "owned",
                    mutators: {},
                });
                const at = Schema.decodeUnknownSync(Schema.toCodecJson(TemporalTimestamp))(
                    "2026-11-09T12:34:56.123456789Z"
                );
                const context = { user: "alice", at, labels: new Set(["saved"]), optional: undefined };
                const bootstrap: OntologyDescription = {
                    version: 1,
                    replication: "committed",
                    sourceId: backend.sourceId,
                    definitionHash: "accepted-definition",
                    ir,
                    context,
                    supportsIdempotency: true,
                    delivery: true,
                    changes: true,
                    watchChanges: true,
                    watchSubset: true,
                    actionParameterResolution: false,
                    queries: true,
                    pins: false,
                    attachments: { stage: false },
                    encrypted: false,
                };
                const catalog = yield* makeReplicaPartitionCatalog();
                yield* Effect.scoped(
                    catalog.open("issues", { ir, backend, context, bootstrap, live: false })
                );
                // A new catalog reads durable metadata without opening a data
                // replica or contacting a provider to rediscover the definition.
                const reopened = yield* makeReplicaPartitionCatalog();
                expect(yield* reopened.lookup("issues")).toEqual({
                    ontology: "issues",
                    partition: { owner: "alice", namespace: "issues" },
                    bootstrap,
                    definition: { ir, context },
                });
                expect(
                    yield* reopened.lookup("issues", { owner: "bob", namespace: "issues" })
                ).toBeUndefined();
                expect(
                    yield* reopened.lookup("issues", { owner: "alice", namespace: "other" })
                ).toBeUndefined();
                const record = yield* reopened.lookup("issues", { owner: "alice", namespace: "issues" });
                expect(record?.bootstrap?.context?.at).toEqual(at);
                expect(record?.bootstrap?.context?.labels).toEqual(new Set(["saved"]));
                yield* reopened.forget("issues");
                expect(yield* reopened.lookup("issues")).toBeUndefined();
                expect(yield* reopened.partitions).toEqual([]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("catalog bootstrap updates preserve the accepted record on source, partition or definition rejection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const boundIR = { ...ir, types: [{ name: "Value", type: o.string({}) }] };
                const backend = yield* makeOwnedBackend({
                    ir: boundIR,
                    tables: yield* Memory.make(),
                    namespace: "owned",
                    mutators: {},
                });
                const context = { user: "alice" };
                const bootstrap: OntologyDescription = {
                    version: 1,
                    replication: "committed",
                    sourceId: backend.sourceId,
                    ir: boundIR,
                    context,
                    supportsIdempotency: true,
                };
                const catalog = yield* makeReplicaPartitionCatalog();
                // Keep the volatile test store alive across replica owner
                // scopes, as a durable driver would across process restarts.
                yield* (yield* Runtimes).acquire({ owner: "alice", namespace: "issues" });
                yield* Effect.scoped(
                    catalog.open("issues", { ir: boundIR, backend, context, bootstrap, live: false })
                );
                for (const description of [
                    { ...bootstrap, context: { user: "bob" } },
                    { ...bootstrap, sourceId: "different-source" },
                    { ...bootstrap, replication: "speculative" as const },
                ]) {
                    expect(yield* Effect.result(catalog.saveBootstrap("issues", description))).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "SourceMismatch" },
                    });
                    expect((yield* catalog.lookup("issues"))?.bootstrap).toEqual(bootstrap);
                }
                expect(
                    yield* Effect.result(catalog.saveBootstrap("issues", { ...bootstrap, ir: undefined }))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
                expect(yield* Effect.result(catalog.saveBootstrap("missing", bootstrap))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotFound" },
                });
                const changedIR = { ...boundIR, types: [{ name: "Value", type: o.integer({}) }] };
                expect(
                    yield* Effect.scoped(
                        Effect.result(
                            catalog.open("issues", {
                                ir: boundIR,
                                backend,
                                context,
                                bootstrap: { ...bootstrap, ir: changedIR },
                                live: false,
                            })
                        )
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "SchemaMismatch" } });
                expect((yield* catalog.lookup("issues"))?.bootstrap).toEqual(bootstrap);
                expect(
                    yield* Effect.scoped(
                        Effect.result(
                            catalog.open("issues", {
                                ir: changedIR,
                                backend,
                                context,
                                bootstrap: { ...bootstrap, ir: changedIR },
                                live: false,
                            })
                        )
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "SchemaMismatch" } });
                expect((yield* catalog.lookup("issues"))?.bootstrap).toEqual(bootstrap);
                const refreshed = {
                    ...bootstrap,
                    ir: { ...boundIR, displayName: "Refreshed" },
                    definitionHash: "accepted-current-hash",
                    queries: true,
                };
                yield* catalog.saveBootstrap("issues", refreshed);
                expect((yield* catalog.lookup("issues"))?.bootstrap).toEqual(refreshed);
                expect((yield* catalog.lookup("issues"))?.definition).toEqual({ ir: refreshed.ir, context });
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("catalog reads legacy inventory entries without inventing an offline bootstrap", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* (yield* Runtimes).acquire({
                    owner: "replica-registry",
                    namespace: "default",
                });
                const inventory = Table.make<StoredReplicaPartition>({ name: "replica-partitions" });
                const old = { ontology: "legacy", partition: { owner: "alice", namespace: "legacy-v1" } };
                yield* metadata.tables.put(inventory, "legacy", old);
                const catalog = yield* makeReplicaPartitionCatalog();
                expect(yield* catalog.lookup("legacy")).toEqual(old);
                expect(yield* catalog.partitions).toEqual([old]);
                expect((yield* metadata.tables.get(inventory, "legacy"))?.bootstrap).toBeUndefined();
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
