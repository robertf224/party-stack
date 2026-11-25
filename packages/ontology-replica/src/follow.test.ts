import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Queue, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { makeReplica } from "./make.js";
import type { ReplicaRowsBatch } from "./visible.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const item = (extra: OntologyIR["objectTypes"][number]["properties"] = []) => ({
    name: "Item",
    displayName: "Item",
    pluralDisplayName: "Items",
    primaryKey: "id",
    properties: [
        { name: "id", displayName: "Id", type: o.string({}) },
        { name: "count", displayName: "Count", type: o.integer({}) },
        ...extra,
    ],
});
const other = {
    name: "Other",
    displayName: "Other",
    pluralDisplayName: "Others",
    primaryKey: "id",
    properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
};
const v1: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "write", displayName: "Write", parameters: [], logic: [] }],
    objectTypes: [item(), other],
};
// Item gains a property; Other is unchanged.
const v2: OntologyIR = {
    ...v1,
    objectTypes: [item([{ name: "label", displayName: "Label", type: o.string({}) }]), other],
};

test("a replica that follows its definition reopens behind the same handle", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                // The source serves rows in the shape of whichever definition asks for them.
                const items = new Map<string, number>([["a", 1]]);
                const source = (ir: OntologyIR) =>
                    makeOntologyBackend({
                        ir,
                        name: "follow",
                        sourceId: "follow",
                        supportsIdempotency: true,
                        queryFunction: () => Effect.void,
                        loadSubset: (request) =>
                            Effect.gen(function* () {
                                const subset = yield* compileObjectSubset(ir, request);
                                const labelled = ir === v2;
                                const rows =
                                    subset.objectType === "Item"
                                        ? [...items].map(([id, count]) => ({
                                              key: id,
                                              value: { id, count, ...(labelled ? { label: "x" } : {}) },
                                          }))
                                        : [];
                                return { complete: true, rows: evaluateQuery(rows, subset.query ?? {}) };
                            }),
                        applyAction: (request) =>
                            Effect.sync(() => {
                                const id = String(request.parameters.id);
                                items.set(id, 1);
                                return {
                                    operationId: request.id,
                                    outcome: "committed" as const,
                                    affected: [{ objectType: "Item", keys: [id] }],
                                };
                            }),
                    });
                const definition = yield* SubscriptionRef.make(v1);
                const built: OntologyIR[] = [];
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "follow" });
                const replica = yield* makeReplica({
                    definition: { kind: "dynamic", changes: SubscriptionRef.changes(definition) },
                    backend: (ir) => Effect.sync(() => (built.push(ir), source(ir))),
                    onDefinitionChange: "reset",
                    outbox: { failureStrategy: "pause" },
                }).pipe(Effect.provideService(Runtime, runtime));
                expect(replica.ir).toBe(v1);

                yield* replica.demand.acquire(
                    { from: { source: { objectType: "Item" }, binding: "item" } },
                    { resultType: "complete" }
                );
                const batches = yield* Queue.unbounded<ReplicaRowsBatch>();
                const observer = yield* replica
                    .observeSubset({ from: { source: { objectType: "Item" }, binding: "item" } })
                    .pipe(
                        Stream.runForEach((batch) => Queue.offer(batches, batch)),
                        Effect.forkScoped
                    );
                const rowsOf = (batch: ReplicaRowsBatch) => batch.rows.map((row) => row.value);
                const untilRows = Effect.gen(function* () {
                    while (true) {
                        const batch = yield* Queue.take(batches);
                        if (batch.rows.length > 0) return rowsOf(batch);
                    }
                });
                expect(yield* untilRows).toEqual([{ id: "a", count: 1 }]);

                yield* SubscriptionRef.set(definition, v2);
                yield* replica.definition.changes.pipe(
                    Stream.filter((ir) => ir === v2),
                    Stream.runHead
                );
                expect(replica.ir).toBe(v2);
                expect(yield* replica.definition.current).toBe(v2);
                expect(built).toEqual([v1, v2]);

                // Item's contract changed, so its rows were cleared; the demand held across the
                // reopen loads them again, now with the new property, and the same live query
                // emits them.
                expect(yield* untilRows).toEqual([{ id: "a", count: 1, label: "x" }]);
                expect(observer.pollUnsafe()).toBeUndefined();

                // Writes go to the new engine.
                yield* replica.outbox.enqueue(
                    { id: "after", name: "write", parameters: { id: "b" } },
                    { optimistic: false }
                );
                expect(yield* replica.outbox.wait("after")).toBeDefined();
                expect(yield* replica.get("Item", "b")).toMatchObject({ id: "b", count: 1 });

                // Setting the same definition again does not reopen.
                yield* SubscriptionRef.set(definition, { ...v2 });
                expect(yield* replica.get("Item", "a")).toMatchObject({ id: "a" });
                expect(built).toEqual([v1, v2]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a schema mismatch from the backend makes the definition source look again", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const definition = yield* SubscriptionRef.make(v1);
                const hints: (readonly string[])[] = [];
                const backendFor = (ir: OntologyIR) =>
                    makeOntologyBackend({
                        ir,
                        name: "mismatch",
                        sourceId: "mismatch",
                        supportsIdempotency: true,
                        queryFunction: () => Effect.void,
                        // The provider has moved on: it rejects the old definition's reads.
                        loadSubset: () =>
                            ir === v2
                                ? Effect.succeed({
                                      complete: true,
                                      rows: [{ key: "a", value: { id: "a", count: 1, label: "x" } }],
                                  })
                                : Effect.fail(
                                      new BackendError({
                                          operation: "load",
                                          kind: "SchemaMismatch",
                                          retryable: false,
                                          message: "Unknown property.",
                                      })
                                  ),
                        applyAction: (request) =>
                            Effect.succeed({ operationId: request.id, outcome: "committed" as const }),
                    });
                const runtime = yield* (yield* Runtimes).acquire({
                    owner: "anonymous",
                    namespace: "mismatch",
                });
                const replica = yield* makeReplica({
                    definition: {
                        kind: "dynamic",
                        changes: SubscriptionRef.changes(definition),
                        revalidate: (hint) =>
                            Effect.andThen(
                                Effect.sync(() => hints.push(hint.objectTypes)),
                                SubscriptionRef.set(definition, v2)
                            ),
                    },
                    backend: (ir) => Effect.sync(() => backendFor(ir)),
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                const item = { from: { source: { objectType: "Item" }, binding: "item" } };
                expect(
                    yield* Effect.result(
                        Effect.scoped(replica.demand.acquire(item, { resultType: "complete" }))
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "SchemaMismatch" } });
                yield* replica.definition.changes.pipe(
                    Stream.filter((ir) => ir === v2),
                    Stream.runHead
                );
                expect(hints[0]).toEqual(["Item"]);
                yield* replica.demand.acquire(item, { resultType: "complete" });
                expect(yield* replica.get("Item", "a")).toEqual({ id: "a", count: 1, label: "x" });
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a definition that cannot open is reported, retried when retryable, and superseded", async () => {
    const v3: OntologyIR = { ...v2, objectTypes: [item(), other] };
    const v4: OntologyIR = {
        ...v1,
        objectTypes: [item([{ name: "size", displayName: "Size", type: o.integer({}) }]), other],
    };
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const definition = yield* SubscriptionRef.make(v1);
                const attempts = new Map<OntologyIR, number>();
                const backendFor = (ir: OntologyIR) =>
                    makeOntologyBackend({
                        ir,
                        name: "failing",
                        sourceId: "failing",
                        supportsIdempotency: true,
                        queryFunction: () => Effect.void,
                        loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                        applyAction: (request) =>
                            Effect.succeed({ operationId: request.id, outcome: "committed" as const }),
                    });
                const factory = (ir: OntologyIR) =>
                    Effect.gen(function* () {
                        const attempt = (attempts.get(ir) ?? 0) + 1;
                        attempts.set(ir, attempt);
                        // v2 fails once with a retryable error; v3 never opens.
                        if (ir === v2 && attempt === 1)
                            return yield* new BackendError({
                                operation: "connect",
                                kind: "Unavailable",
                                retryable: true,
                                message: "Offline.",
                            });
                        if (ir === v3)
                            return yield* new BackendError({
                                operation: "connect",
                                kind: "InvalidConfiguration",
                                retryable: false,
                                message: "Cannot compile.",
                            });
                        return backendFor(ir);
                    });
                const runtime = yield* (yield* Runtimes).acquire({
                    owner: "anonymous",
                    namespace: "failing",
                });
                const replica = yield* makeReplica({
                    definition: { kind: "dynamic", changes: SubscriptionRef.changes(definition) },
                    backend: factory,
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                expect(yield* replica.definition.status.get).toEqual({ ir: v1 });
                const statusWhere = (
                    check: (status: { ir: OntologyIR; failed?: { ir: OntologyIR } }) => boolean
                ) => replica.definition.status.changes.pipe(Stream.filter(check), Stream.runHead);

                // A retryable failure keeps serving v1 and reports v2 as retrying.
                yield* SubscriptionRef.set(definition, v2);
                yield* statusWhere((status) => status.failed?.ir === v2);
                expect(yield* replica.definition.status.get).toMatchObject({
                    ir: v1,
                    failed: { ir: v2, retrying: true, error: { kind: "Unavailable" } },
                });
                expect(replica.ir).toBe(v1);
                expect(yield* replica.get("Item", "missing")).toBeUndefined();

                // The retry opens it and clears the failure.
                yield* TestClock.adjust("5 seconds");
                yield* statusWhere((status) => status.ir === v2 && !status.failed);
                expect(replica.ir).toBe(v2);
                expect(attempts.get(v2)).toBe(2);

                // A non-retryable failure waits for a different definition.
                yield* SubscriptionRef.set(definition, v3);
                yield* statusWhere((status) => status.failed?.ir === v3);
                expect(yield* replica.definition.status.get).toMatchObject({
                    ir: v2,
                    failed: { ir: v3, retrying: false, error: { kind: "InvalidConfiguration" } },
                });
                yield* TestClock.adjust("10 minutes");
                expect(attempts.get(v3)).toBe(1);

                yield* SubscriptionRef.set(definition, v4);
                yield* statusWhere((status) => status.ir === v4 && !status.failed);
                expect(replica.ir).toBe(v4);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)), Effect.provide(TestClock.layer()))
        )
    );
});
