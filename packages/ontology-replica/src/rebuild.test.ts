import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { ConfigurationError, OntologyStorageError, Table } from "@party-stack/ontology-storage/tables";
import {
    MemoryRuntime,
    Runtimes,
    Runtime,
    RuntimePartition,
    MemoryBlobBytesStore,
} from "@party-stack/runtime";
import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplicaPartitionCatalog } from "./registry.js";
import type { OntologyDescription } from "@party-stack/ontology-backend/description";
import type { PendingAction } from "@party-stack/ontology-backend/protocol";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Key } from "@party-stack/ontology-storage";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
};
const next: OntologyIR = {
    ...ir,
    objectTypes: [
        {
            ...ir.objectTypes[0]!,
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.string({}) },
            ],
        },
    ],
};
const table = <A = unknown>(part: string) =>
    Table.make<A>({ name: JSON.stringify(["replica", "issues", part]) });
const pending: PendingAction = {
    invocation: { id: "pending", name: "write", parameters: {} },
    requestIdentity: "fixture",
    createdAt: 0,
    sequence: 1,
    state: "queued",
    optimistic: false,
    attempts: 0,
    touchedTypes: [],
};

const setup = Effect.gen(function* () {
    const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "issues" });
    const backend = yield* makeOwnedBackend({
        ir,
        namespace: "source",
        tables: yield* Memory.make(),
        mutators: {},
    });
    const bootstrap: OntologyDescription = {
        version: 1,
        replication: "committed",
        sourceId: backend.sourceId,
        ir,
        context: {},
        supportsIdempotency: true,
    };
    const catalog = yield* makeReplicaPartitionCatalog();
    const opened = yield* catalog.open("issues", { ir, backend, bootstrap, live: false });
    const replacement = { ...bootstrap, ir: next };
    return { catalog, runtime, backend, opened, replacement };
});

test("rebuild atomically drops disposable data while preserving outcomes, source identity and desired pin", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { catalog, runtime, backend, opened, replacement } = yield* setup;
                yield* runtime.tables.put(table("base:Item"), "old", { id: "old", count: 1 });
                yield* runtime.tables.put(table("coverage"), "old", { complete: true });
                const desired = {
                    generation: "desired",
                    query: { select: [] },
                    inputs: { label: "saved" },
                    attachments: "all",
                };
                yield* runtime.tables.put(table("query-pin"), "head", {
                    desired,
                    installed: desired,
                    error: { kind: "Unavailable", message: "old" },
                });
                const outcome = { ...pending, completedAt: 1 };
                for (const part of [
                    "completed",
                    "parent-completed",
                    "journal-receipts",
                    "clients",
                    "submissions",
                ])
                    yield* runtime.tables.put(table(part), "retained", outcome);
                const head = yield* runtime.tables.get(table("state-head"), "head");
                yield* catalog.rebuild("issues", replacement);
                expect(yield* runtime.tables.query(table("base:Item"))).toEqual([]);
                expect(yield* runtime.tables.query(table("coverage"))).toEqual([]);
                expect(yield* runtime.tables.get(table("query-pin"), "head")).toEqual({ desired });
                expect(yield* runtime.tables.get(table("state-head"), "head")).toEqual(head);
                for (const part of [
                    "completed",
                    "parent-completed",
                    "journal-receipts",
                    "clients",
                    "submissions",
                ])
                    expect(yield* runtime.tables.get(table(part), "retained")).toEqual(outcome);
                expect((yield* catalog.lookup("issues"))?.rebuild).toBeUndefined();
                expect((yield* catalog.lookup("issues"))?.definition?.ir).toEqual(next);
                expect(yield* Effect.result(opened.replica.demand.clearPin)).toMatchObject({
                    _tag: "Failure",
                });
                const reopened = yield* catalog.open("issues", {
                    ir: next,
                    backend,
                    bootstrap: replacement,
                    live: false,
                });
                expect(yield* reopened.replica.confirmed.get("Item", "old")).toBeUndefined();
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("rebuild refuses both own pending intent and accepted parent intent before recording a reset", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { catalog, runtime, replacement, opened } = yield* setup;
                for (const part of ["outbox", "parent-pending"]) {
                    let retired = false;
                    yield* runtime.tables.put(table(part), "pending", pending);
                    yield* runtime.tables.put(table("base:Item"), "old", { id: "old", count: 1 });
                    expect(
                        yield* Effect.result(
                            catalog.rebuild("issues", replacement, {
                                onRetire: Effect.sync(() => {
                                    retired = true;
                                }),
                            })
                        )
                    ).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Conflict" },
                    });
                    expect(retired).toBe(false);
                    expect(yield* runtime.tables.get(table(part), "pending")).toEqual(pending);
                    expect(yield* runtime.tables.get(table("base:Item"), "old")).toEqual({
                        id: "old",
                        count: 1,
                    });
                    expect((yield* catalog.lookup("issues"))?.rebuild).toBeUndefined();
                    expect(yield* opened.replica.confirmed.get("Item", "old")).toEqual({
                        id: "old",
                        count: 1,
                    });
                    yield* runtime.tables.delete(table(part), "pending");
                }
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a durable rebuild marker resumes without repeating a committed reset or deleting subsequent intent", async () => {
    let finalization = false;
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const memory = yield* Memory.make();
            const partition = yield* RuntimePartition;
            return yield* Runtime.make({
                blobBytes: new MemoryBlobBytesStore(),
                tables: {
                    ...memory,
                    put: (target, key, value) =>
                        finalization &&
                        partition.owner === "replica-registry" &&
                        target.name === "replica-partitions" &&
                        typeof value === "object" &&
                        value !== null &&
                        !Reflect.has(value, "rebuild")
                            ? Effect.fail(
                                  new OntologyStorageError({
                                      operation: "test",
                                      reason: new ConfigurationError({
                                          message: "Interrupted manifest save",
                                      }),
                                  })
                              )
                            : memory.put(target, key, value),
                },
            });
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { catalog, runtime, replacement, backend } = yield* setup;
                // Fail only the catalog finalization, after the data reset is committed.
                finalization = true;
                expect(yield* Effect.result(catalog.rebuild("issues", replacement))).toMatchObject({
                    _tag: "Failure",
                });
                finalization = false;
                yield* runtime.tables.put(table("base:Item"), "new", { id: "new", count: "after-reset" });
                yield* runtime.tables.put(table("outbox"), "pending", pending);
                const reopened = yield* catalog.open("issues", {
                    ir: next,
                    backend,
                    bootstrap: replacement,
                    live: false,
                });
                expect(yield* runtime.tables.get(table("outbox"), "pending")).toEqual(pending);
                expect(yield* reopened.replica.confirmed.get("Item", "new")).toEqual({
                    id: "new",
                    count: "after-reset",
                });
                expect((yield* catalog.lookup("issues"))?.rebuild).toBeUndefined();
                // No acquisition is necessary to read the retained new-schema cache.
                yield* Effect.scoped(
                    reopened.replica.demand.acquire(objectSubset("Item"), { localOnly: true })
                );
            }).pipe(Effect.provide(Runtimes.layer(platform)))
        )
    );
});

test("a write racing the preflight retires the owner but leaves its old manifest and pending intent reopenable", async () => {
    let race = false;
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const memory = yield* Memory.make();
            const partition = yield* RuntimePartition;
            return yield* Runtime.make({
                blobBytes: new MemoryBlobBytesStore(),
                tables: {
                    ...memory,
                    read: (body) => {
                        let inspected = false;
                        return memory
                            .read((tx) =>
                                body({
                                    ...tx,
                                    get: <A>(target: Table<A>, key: Key) => {
                                        if (
                                            race &&
                                            partition.namespace === "issues" &&
                                            target.name === table("position").name
                                        )
                                            inspected = true;
                                        return tx.get(target, key);
                                    },
                                })
                            )
                            .pipe(
                                Effect.tap(() =>
                                    inspected
                                        ? Effect.gen(function* () {
                                              race = false;
                                              yield* memory.put(table("outbox"), "pending", pending);
                                          })
                                        : Effect.void
                                )
                            );
                    },
                },
            });
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { catalog, runtime, replacement, backend, opened } = yield* setup;
                yield* runtime.tables.put(table("base:Item"), "old", { id: "old", count: 1 });
                race = true;
                let retired = false;
                expect(
                    yield* Effect.result(
                        catalog.rebuild("issues", replacement, {
                            onRetire: Effect.sync(() => {
                                retired = true;
                            }),
                        })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "Conflict" },
                });
                expect(retired).toBe(true);
                expect(yield* Effect.result(opened.replica.confirmed.get("Item", "old"))).toMatchObject({
                    _tag: "Failure",
                });
                const saved = yield* catalog.lookup("issues");
                expect(saved?.rebuild).toBeUndefined();
                expect(saved?.definition?.ir).toEqual(ir);
                const reopened = yield* catalog.open("issues", {
                    ir,
                    backend,
                    bootstrap: saved?.bootstrap,
                    live: false,
                });
                expect(yield* reopened.replica.confirmed.get("Item", "old")).toEqual({ id: "old", count: 1 });
                expect(
                    (yield* runtime.tables.get(table<PendingAction>("outbox"), "pending"))?.invocation
                ).toEqual(pending.invocation);
            }).pipe(Effect.provide(Runtimes.layer(platform)))
        )
    );
});
