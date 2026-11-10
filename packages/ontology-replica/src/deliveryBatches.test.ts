import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Row",
            displayName: "Row",
            pluralDisplayName: "Rows",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
    actionTypes: [{ name: "seed", displayName: "Seed", parameters: [], logic: [] }],
};

test("delivery installs distinct base rows and their metadata in bounded storage batches", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* makeOwnedBackend({
                    namespace: "delivery-batch-authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {
                        seed: (tx) =>
                            Effect.forEach(
                                Array.from({ length: 300 }, (_, index) => `row-${index}`),
                                (id) => tx.put("Row", { id }),
                                { discard: true }
                            ),
                    },
                });
                yield* authority.applyAction({ id: "seed", name: "seed", parameters: {} });
                const storage = yield* Memory.make();
                const namespace = "delivery-batch-child";
                const observed = ["base:Row", "delivery-seen", "retention"].map((part) =>
                    JSON.stringify(["replica", namespace, part])
                );
                const singles = new Map<string, number>();
                const batches = new Map<string, number[]>();
                const child = yield* makeReplica({
                    namespace,
                    ir,
                    backend: authority,
                    execute: () => Effect.void,
                    startSync: false,
                    objectCacheGc: false,
                    tables: {
                        ...storage,
                        transaction: (body) =>
                            storage.transaction((tx) =>
                                body({
                                    ...tx,
                                    put: (table, key, value) => {
                                        if (observed.includes(table.name))
                                            singles.set(table.name, (singles.get(table.name) ?? 0) + 1);
                                        return tx.put(table, key, value);
                                    },
                                    putMany: (table, rows) => {
                                        if (observed.includes(table.name)) {
                                            const sizes = batches.get(table.name) ?? [];
                                            sizes.push(rows.length);
                                            batches.set(table.name, sizes);
                                        }
                                        return tx.putMany(table, rows);
                                    },
                                })
                            ),
                    },
                });
                yield* child.demand({ objectType: "Row" });
                const opened = yield* child.openParentDelivery();
                yield* opened.subscription.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runForEach((frame) =>
                        child
                            .receiveDelivery(frame, opened.generation)
                            .pipe(
                                Effect.flatMap((installed) =>
                                    installed
                                        ? opened.subscription.acknowledge(installed.position)
                                        : Effect.void
                                )
                            )
                    )
                );
                expect(yield* child.confirmed.loadSubset("Row")).toHaveLength(300);
                for (const table of observed) {
                    expect(singles.get(table) ?? 0).toBe(0);
                    expect(batches.get(table)).toEqual([128, 128, 44]);
                }
            })
        )
    );
});
