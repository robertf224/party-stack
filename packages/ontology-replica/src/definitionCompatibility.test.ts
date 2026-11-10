import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplica } from "./testing.js";
import type { ReplicaOptions } from "./testing.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const definition = (label: string, countType = o.integer({})): OntologyIR => ({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: label,
            pluralDisplayName: label,
            primaryKey: "id",
            color: label,
            properties: [
                { name: "id", displayName: label, type: o.string({}) },
                { name: "count", displayName: label, type: countType },
            ],
        },
    ],
    actionTypes: [{ name: "write", displayName: label, parameters: [], logic: [] }],
});

test("cosmetic definition updates preserve rows, coverage, pin retention and queued intent across owner restart", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const ir = definition("Old");
                const tables = yield* Memory.make();
                const backend = yield* makeOwnedBackend({
                    ir,
                    namespace: "definition-source",
                    tables: yield* Memory.make(),
                    mutators: {
                        write: (tx, action) =>
                            tx.put("Item", { id: action.parameters.id, count: action.parameters.count }),
                    },
                });
                yield* backend.applyAction({
                    id: "seed",
                    name: "write",
                    parameters: { id: "item", count: 1 },
                });
                const owner = yield* Scope.fork(yield* Effect.scope);
                const options: ReplicaOptions = {
                    ir,
                    tables,
                    namespace: "definition-cache",
                    backend,
                    startSync: false,
                    execute: (tx) => tx.put("Item", { id: "item", count: 2 }),
                };
                const original = yield* Scope.provide(makeReplica(options), owner);
                yield* Scope.provide(original.demand({ objectType: "Item" }), owner);
                yield* original.syncSubset({ objectType: "Item" });
                yield* original.pin("Item", "item", true);
                yield* original.enqueue({ id: "offline", name: "write", parameters: {} });
                const sourceId = original.sourceId;
                yield* Scope.close(owner, Exit.void);

                const reopenedScope = yield* Scope.fork(yield* Effect.scope);
                const reopened = yield* Scope.provide(
                    makeReplica({ ...options, ir: definition("New") }),
                    reopenedScope
                );
                expect(reopened.sourceId).toBe(sourceId);
                expect(yield* reopened.loadSubset("Item")).toEqual([
                    { key: "item", value: { id: "item", count: 2 } },
                ]);
                expect((yield* reopened.pending).map((entry) => entry.invocation.id)).toEqual(["offline"]);
                // An optimistic write legitimately marks freshness stale; its
                // historical complete proof must still survive the rename.
                const coverage = Table.make<{ complete?: boolean }>({
                    name: JSON.stringify(["replica", "definition-cache", "coverage"]),
                });
                expect((yield* tables.query(coverage)).some((row) => row.value.complete)).toBe(true);
                expect(yield* reopened.collectGarbage({ minUnusedAgeMs: 0 })).toBe(0);
                yield* Scope.close(reopenedScope, Exit.void);

                // A genuine contract change must not reinterpret the retained data or
                // erase the pending invocation when acquisition fails.
                const changed = definition("New");
                changed.objectTypes[0]!.properties[1]!.type = o.string({});
                expect(yield* Effect.result(makeReplica({ ...options, ir: changed }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "SchemaMismatch" },
                });
                const preserved = yield* makeReplica({ ...options, ir: definition("Newest") });
                expect((yield* preserved.pending).map((entry) => entry.invocation.id)).toEqual(["offline"]);
                expect((yield* preserved.loadSubset("Item"))[0]?.value.count).toBe(2);
            })
        )
    );
});
