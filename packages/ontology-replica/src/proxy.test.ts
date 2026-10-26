import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeReplica, makeCachedProxy } from "./index.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [{ name: "save", displayName: "Save", parameters: [], logic: [] }],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
};
test("cached proxy shares demand, forwards writes, and never enqueues them locally", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        save: (tx) =>
                            Effect.gen(function* () {
                                const previous = yield* tx.get("Item", "one");
                                yield* tx.put("Item", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                            }),
                    },
                });
                let loads = 0;
                const backend = {
                    ...owned,
                    changes: undefined,
                    pollIntervalMs: () => false as const,
                    loadSubset: (subset: Parameters<typeof owned.loadSubset>[0]) =>
                        Effect.sync(() => loads++).pipe(Effect.andThen(owned.loadSubset(subset))),
                };
                const replica = yield* makeReplica({
                    namespace: "cache",
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    startSync: false,
                    execute: () => Effect.void,
                });
                const proxy = yield* makeCachedProxy({
                    replica,
                    backend,
                    idleDemandMs: 60_000,
                    maxSubsets: 1,
                });
                const subset = { objectType: "Item" };
                yield* proxy.loadSubset(subset);
                yield* proxy.loadSubset(subset);
                expect(loads).toBe(1);
                expect((yield* replica.status).demands).toHaveLength(1);
                const overflow = yield* Effect.result(
                    proxy.loadSubset({ objectType: "Item", query: { where: eq(field("id"), "other") } })
                );
                expect(overflow).toMatchObject({ _tag: "Failure", failure: { kind: "RateLimited" } });
                const quietProxy = yield* makeCachedProxy({
                    replica,
                    backend: {
                        ...backend,
                        invoke: (action) =>
                            Effect.succeed({
                                invocationId: action.id,
                                outcome: "committed",
                                affected: [{ objectType: "Telemetry" }],
                                affectedComplete: true,
                            }),
                    },
                });
                yield* quietProxy.invoke({ id: "event", name: "recordEvent", parameters: {} });
                yield* proxy.loadSubset(subset);
                expect(loads).toBe(1);
                const receipt = yield* proxy.invoke({ id: "one", name: "save", parameters: {} });
                expect(receipt.outcome).toBe("committed");
                expect(yield* replica.pending).toEqual([]);
                expect((yield* proxy.loadSubset(subset)).rows[0]?.value.count).toBe(1);
                expect(yield* replica.pending).toEqual([]);
            })
        )
    );
});

test("cached proxy never promotes an incomplete source snapshot to complete coverage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = {
                    name: "incomplete",
                    sourceId: "incomplete",
                    supportsIdempotency: false,
                    loadSubset: () =>
                        Effect.succeed({
                            rows: [{ key: "one", value: { id: "one", count: 1 } }],
                            complete: false,
                        }),
                    invoke: () => Effect.die("unused"),
                    queryFunction: () => Effect.void,
                };
                const replica = yield* makeReplica({
                    namespace: "partial",
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    execute: () => Effect.void,
                    startSync: false,
                });
                const proxy = yield* makeCachedProxy({ replica, backend });
                const snapshot = yield* proxy.loadSubset({ objectType: "Item" });
                expect(snapshot.complete).toBe(false);
                expect(snapshot.rows).toHaveLength(1);
            })
        )
    );
});
