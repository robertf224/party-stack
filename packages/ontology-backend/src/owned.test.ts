import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import { makeOwnedBackend, type OwnedTransaction } from "./owned.js";
import { BackendError } from "./index.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Counter", "Other"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: name,
        primaryKey: "id",
        properties: [
            { name: "id", displayName: "Id", type: o.string({}) },
            { name: "count", displayName: "Count", type: o.integer({}) },
        ],
    })),
    actionTypes: ["increment", "fail"].map((name) => ({
        name,
        displayName: name,
        logic: [],
        parameters: [
            { name: "id", displayName: "Id", type: o.string({}) },
            { name: "amount", displayName: "Amount", type: o.integer({}) },
        ],
    })),
};
const rejected = () =>
    new BackendError({
        operation: "invoke",
        kind: "Rejected",
        message: "Expected rejection",
        retryable: false,
    });

test("owned commits atomically persist rows, receipts, and ordered source-scoped change batches", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            let escaped: OwnedTransaction | undefined;
            const options = {
                namespace: "owned-test",
                ir,
                tables,
                mutators: {
                    increment: (tx: OwnedTransaction, action: { parameters: Record<string, unknown> }) =>
                        Effect.gen(function* () {
                            escaped = tx;
                            const id = action.parameters.id as string;
                            const previous = yield* tx.get("Counter", id);
                            yield* tx.put("Counter", {
                                id,
                                count: Number(previous?.count ?? 0) + Number(action.parameters.amount),
                            });
                            const ownWrite = yield* tx.get("Counter", id);
                            expect(ownWrite?.count).toBe(
                                Number(previous?.count ?? 0) + Number(action.parameters.amount)
                            );
                        }),
                    fail: (tx: OwnedTransaction) =>
                        Effect.gen(function* () {
                            yield* tx.put("Counter", { id: "rollback", count: 99 });
                            yield* tx.put("Other", { id: "rollback", count: 99 });
                            return yield* rejected();
                        }),
                },
            };
            const backend = yield* makeOwnedBackend(options);
            const invocation = { id: "one", name: "increment", parameters: { id: "counter", amount: 1 } };
            const receipt = yield* backend.invoke(invocation);
            expect(receipt.outcome).toBe("committed");
            expect(
                yield* backend.invoke({ ...invocation, parameters: { amount: 1, id: "counter" } })
            ).toEqual(receipt);
            const reopened = yield* makeOwnedBackend(options);
            expect(yield* reopened.invoke(invocation)).toEqual(receipt);
            expect(Result.isFailure(yield* Effect.result(escaped!.get("Counter", "counter")))).toBe(true);
            const conflict = yield* Effect.result(
                backend.invoke({ ...invocation, parameters: { id: "counter", amount: 2 } })
            );
            expect(Result.isFailure(conflict) && conflict.failure.kind).toBe("Conflict");
            const snapshot = yield* backend.loadSubset({ objectType: "Counter" });
            expect(snapshot.rows).toEqual([{ key: "counter", value: { id: "counter", count: 1 } }]);
            expect(snapshot.cursor).toBe(receipt.cursor);
            const failed = yield* Effect.result(
                backend.invoke({ id: "failed", name: "fail", parameters: { id: "ignored", amount: 1 } })
            );
            expect(Result.isFailure(failed)).toBe(true);
            expect((yield* backend.loadSubset({ objectType: "Other" })).rows).toEqual([]);
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows).toEqual(snapshot.rows);
            const all = yield* backend.changes!.pull({});
            expect(all.commits).toEqual([
                {
                    cursor: receipt.cursor,
                    invocationId: "one",
                    changes: [
                        {
                            kind: "put",
                            objectType: "Counter",
                            key: "counter",
                            value: { id: "counter", count: 1 },
                        },
                    ],
                },
            ]);
            expect((yield* backend.changes!.pull({ cursor: snapshot.cursor })).commits).toEqual([]);
            const invalid = yield* Effect.result(
                backend.changes!.pull({ cursor: JSON.stringify({ source: "other", revision: 1 }) })
            );
            expect(Result.isFailure(invalid) && invalid.failure.kind).toBe("InvalidCursor");
        })
    );
});

test("concurrent actions read their transaction state and journal pagination never skips commits", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const backend = yield* makeOwnedBackend({
                namespace: "concurrent",
                ir,
                tables,
                mutators: {
                    increment: (tx, action) =>
                        Effect.gen(function* () {
                            const previous = yield* tx.get("Counter", action.parameters.id as string);
                            yield* Effect.yieldNow;
                            yield* tx.put("Counter", {
                                id: action.parameters.id,
                                count: Number(previous?.count ?? 0) + 1,
                            });
                        }),
                },
            });
            yield* Effect.all(
                Array.from({ length: 12 }, (_, index) =>
                    backend.invoke({
                        id: `invocation-${index}`,
                        name: "increment",
                        parameters: { id: "shared", amount: 1 },
                    })
                ),
                { concurrency: "unbounded" }
            );
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(12);
            let cursor: string | undefined;
            const ids: string[] = [];
            do {
                const page = yield* backend.changes!.pull({ cursor, limit: 3 });
                ids.push(...page.commits.map((commit) => commit.invocationId!));
                cursor = page.cursor;
                if (!page.hasMore) break;
            } while (true);
            expect(new Set(ids).size).toBe(12);
            expect(ids).toHaveLength(12);
        })
    );
});
