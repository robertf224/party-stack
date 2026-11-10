import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Tracer } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "text", displayName: "Text", type: o.string({}) },
            ],
        },
    ],
};

test("snapshot prior-value reads use native keys and distinguish inserts, changes, and unchanged retention", async () => {
    const spans: Tracer.Span[] = [];
    const tracer = Tracer.make({
        span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
        },
    });
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const storage = yield* Memory.make();
                const namespace = "snapshot-reads";
                const baseTable = JSON.stringify(["replica", namespace, "base:Item"]);
                let keyIndexQueries = 0;
                const writes: number[] = [];
                let rows = Array.from({ length: 300 }, (_, index) => ({
                    key: `item-${index}`,
                    value: { id: `item-${index}`, text: `Text ${index}` },
                }));
                const replica = yield* makeReplica({
                    namespace,
                    ir,
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                    backend: makeOntologyBackend({
                        ir,
                        name: "snapshot-only",
                        sourceId: "snapshot-only",
                        supportsIdempotency: false,
                        applyAction: () => Effect.die("Unexpected action"),
                        queryFunction: () => Effect.void,
                        loadSubset: () => Effect.succeed({ rows, complete: true }),
                    }),
                    tables: {
                        ...storage,
                        transaction: (body) =>
                            storage.transaction((tx) =>
                                body({
                                    ...tx,
                                    query: new Proxy(tx.query, {
                                        apply(target, thisArg, args) {
                                            const [table, query] = args as Parameters<typeof tx.query>;
                                            if (
                                                "name" in table &&
                                                table.name === baseTable &&
                                                query?.where?.op === "in"
                                            )
                                                keyIndexQueries++;
                                            return Reflect.apply(target, thisArg, args);
                                        },
                                    }),
                                    putMany: (table, batch) => {
                                        if (table.name === baseTable && batch.length)
                                            writes.push(batch.length);
                                        return tx.putMany(table, batch);
                                    },
                                })
                            ),
                    },
                });
                yield* replica.demand({ objectType: "Item" });
                yield* replica.syncOnce;
                expect(yield* replica.loadSubset("Item")).toHaveLength(300);
                expect(writes).toEqual([128, 128, 44]);
                expect(keyIndexQueries).toBe(0);
                const installed = () =>
                    Object.fromEntries(
                        spans.filter((span) => span.name === "Replica.snapshot.write").at(-1)?.attributes ??
                            []
                    );
                expect(installed()).toMatchObject({
                    rows: 300,
                    inserted: 300,
                    updated: 0,
                    unchanged: 0,
                    changed: 300,
                    retentionRows: 300,
                    removed: 0,
                });

                rows = rows
                    .slice(1)
                    .map((row, index) =>
                        index === 0 ? { ...row, value: { ...row.value, text: "Changed" } } : row
                    );
                rows.push({ key: "new", value: { id: "new", text: "New" } });
                writes.length = 0;
                yield* replica.invalidate(["Item"]);
                yield* replica.syncOnce;
                expect(yield* replica.get("Item", "item-0")).toBeUndefined();
                expect((yield* replica.get("Item", "item-1"))?.text).toBe("Changed");
                expect(writes.reduce((total, count) => total + count, 0)).toBe(2);
                expect(installed()).toMatchObject({
                    rows: 300,
                    inserted: 1,
                    updated: 1,
                    unchanged: 298,
                    changed: 2,
                    retentionRows: 300,
                    removed: 1,
                });

                writes.length = 0;
                yield* replica.invalidate(["Item"]);
                yield* replica.syncOnce;
                expect(writes).toEqual([]);
                expect(keyIndexQueries).toBe(0);
                expect(installed()).toMatchObject({
                    rows: 300,
                    inserted: 0,
                    updated: 0,
                    unchanged: 300,
                    changed: 0,
                    retentionRows: 300,
                    removed: 0,
                });
            })
        ).pipe(Effect.provideService(Tracer.Tracer, tracer))
    );
});
