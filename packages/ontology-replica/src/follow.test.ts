import { BackendError, makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery, ontologyDefinitionContractHash } from "@party-stack/ontology-storage";
import { MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Queue, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplica } from "./make.js";
import { editableMetadata } from "./testing.js";
import type { ReplicaStatus } from "./status.js";
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
const labelled = (ir: OntologyIR) =>
    ir.objectTypes.some((type) => type.properties.some(({ name }) => name === "label"));
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
                                const isLabelled = labelled(ir);
                                const rows =
                                    subset.objectType === "Item"
                                        ? [...items].map(([id, count]) => ({
                                              key: id,
                                              value: { id, count, ...(isLabelled ? { label: "x" } : {}) },
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
                const metadata = yield* editableMetadata(v1);
                const built: OntologyIR[] = [];
                const runtime = yield* (yield* Runtimes).acquire({ owner: "anonymous", namespace: "follow" });
                const replica = yield* makeReplica({
                    definition: { kind: "dynamic", meta: metadata.backend },
                    backend: (ir) => Effect.sync(() => (built.push(ir), source(ir))),
                    onDefinitionChange: "reset",
                    outbox: { failureStrategy: "pause" },
                }).pipe(Effect.provideService(Runtime, runtime));
                expect(labelled(replica.ir)).toBe(false);

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

                yield* metadata.edit(v2);
                yield* replica.definition.changes.pipe(Stream.filter(labelled), Stream.runHead);
                expect(labelled(replica.ir)).toBe(true);
                expect(labelled(yield* replica.definition.current)).toBe(true);
                expect(built.map(labelled)).toEqual([false, true]);

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

                // Metadata that changes to the same definition does not reopen.
                yield* metadata.edit({ ...v2 });
                yield* Effect.sleep("200 millis");
                expect(yield* replica.get("Item", "a")).toMatchObject({ id: "a" });
                expect(built.map(labelled)).toEqual([false, true]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("a definition that cannot open is reported in status until one opens", async () => {
    const v3: OntologyIR = {
        ...v1,
        objectTypes: [item([{ name: "size", displayName: "Size", type: o.integer({}) }]), other],
    };
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const metadata = yield* editableMetadata(v1);
                const has = (ir: OntologyIR, property: string) =>
                    ir.objectTypes.some((type) => type.properties.some(({ name }) => name === property));
                const factory = (ir: OntologyIR) =>
                    has(ir, "label")
                        ? Effect.fail(
                              new BackendError({
                                  operation: "connect",
                                  kind: "InvalidConfiguration",
                                  retryable: false,
                                  message: "Cannot compile.",
                              })
                          )
                        : Effect.succeed(
                              makeOntologyBackend({
                                  ir,
                                  name: "failing",
                                  sourceId: "failing",
                                  supportsIdempotency: true,
                                  queryFunction: () => Effect.void,
                                  loadSubset: () => Effect.succeed({ complete: true, rows: [] }),
                                  applyAction: (request) =>
                                      Effect.succeed({
                                          operationId: request.id,
                                          outcome: "committed" as const,
                                      }),
                              })
                          );
                const runtime = yield* (yield* Runtimes).acquire({
                    owner: "anonymous",
                    namespace: "failing",
                });
                const replica = yield* makeReplica({
                    definition: { kind: "dynamic", meta: metadata.backend },
                    backend: factory,
                    onDefinitionChange: "reset",
                }).pipe(Effect.provideService(Runtime, runtime));
                const [h1, h2, h3] = yield* Effect.all([v1, v2, v3].map(ontologyDefinitionContractHash));
                const statusWhere = (check: (status: ReplicaStatus) => boolean) =>
                    replica.status.changes.pipe(Stream.filter(check), Stream.runHead);
                expect((yield* replica.status.get).definition).toEqual({ hash: h1 });

                // v2 cannot open: the replica keeps serving v1 and reports v2's failure.
                yield* metadata.edit(v2);
                yield* statusWhere((status) => status.definition?.error !== undefined);
                expect((yield* replica.status.get).definition).toEqual({
                    hash: h1,
                    error: { hash: h2, kind: "InvalidConfiguration", message: "Cannot compile." },
                });
                expect(has(replica.ir, "label")).toBe(false);
                expect(yield* replica.get("Item", "missing")).toBeUndefined();

                // The next definition that opens clears it.
                yield* metadata.edit(v3);
                yield* statusWhere((status) => status.definition?.hash === h3 && !status.definition?.error);
                expect(has(replica.ir, "size")).toBe(true);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});
