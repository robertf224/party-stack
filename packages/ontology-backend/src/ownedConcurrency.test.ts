import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { makeOwnedBackend } from "./owned.js";
import { objectSubset } from "./subset.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const faults = vi.hoisted(() => ({ readBack: false }));

// Model an async driver returning a read before the caller resumes. This exposes
// interleavings hidden by the memory driver's otherwise synchronous reads.
vi.mock("@party-stack/ontology-storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@party-stack/ontology-storage")>();
    const make: typeof actual.makeOntologyStorage = (...args) => {
        const storage = actual.makeOntologyStorage(...args);
        return {
            ...storage,
            transaction: (body) =>
                storage.transaction((native) =>
                    body({
                        ...native,
                        get: (store, key) =>
                            native.get(store, key).pipe(
                                Effect.flatMap((value) =>
                                    faults.readBack
                                        ? Effect.fail(
                                              new actual.OntologyStorageError({
                                                  operation: "read",
                                                  reason: new actual.SchemaMismatch({
                                                      message: "Read unavailable",
                                                      table: "Item",
                                                      expected: 1,
                                                      actual: 2,
                                                  }),
                                              })
                                          )
                                        : Effect.succeed(value)
                                ),
                                Effect.tap(() => Effect.yieldNow)
                            ),
                    })
                ),
        };
    };
    return { ...actual, makeOntologyStorage: make };
});

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                ...["left", "right"].map((name) => ({ name, displayName: name, type: o.integer({}) })),
            ],
        },
    ],
};

test("async reads cannot make parallel patches overwrite each other's fields or journal stale values", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const backend = yield* makeOwnedBackend({
                namespace: "async-patches",
                ir,
                tables: yield* Memory.make(),
                mutators: {},
            });
            yield* backend.storage.transaction((tx) => tx.put("Item", { id: "one", left: 0, right: 0 }));
            const before = yield* backend.loadSubset(objectSubset("Item"));
            yield* backend.storage.transaction((tx) =>
                Effect.all(
                    [
                        tx.patch("Item", "one", [{ path: ["left"], value: 1 }]),
                        tx.patch("Item", "one", [{ path: ["right"], value: 2 }]),
                    ],
                    { concurrency: "unbounded" }
                )
            );
            const expected = { id: "one", left: 1, right: 2 };
            expect(yield* backend.storage.read((tx) => tx.get("Item", "one"))).toEqual(expected);
            expect((yield* backend.changes!.pull({ cursor: before.cursor })).commits[0]?.changes).toEqual([
                { kind: "put", objectType: "Item", key: "one", value: expected },
            ]);
        }).pipe(Effect.scoped)
    );
});

test("a caught read-back failure cannot leave committed object changes missing from the journal", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const backend = yield* makeOwnedBackend({
                namespace: "read-back",
                ir,
                tables: yield* Memory.make(),
                mutators: {},
            });
            faults.readBack = true;
            yield* backend.storage.transaction((tx) =>
                tx.put("Item", { id: "one", left: 1, right: 2 }).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.ensuring(
                        Effect.sync(() => {
                            faults.readBack = false;
                        })
                    )
                )
            );
            const rows = (yield* backend.loadSubset(objectSubset("Item"))).rows;
            expect(rows).toHaveLength(1);
            expect((yield* backend.changes!.pull({})).commits.flatMap((commit) => commit.changes)).toEqual([
                { kind: "put", objectType: "Item", key: "one", value: rows[0]!.value },
            ]);
        }).pipe(Effect.scoped)
    );
});
