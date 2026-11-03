import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeOwnedBackend } from "./owned.js";
import { objectSubset } from "./subset.js";
import { BackendError } from "./index.js";
import type { ActionRequest } from "./index.js";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: ["increment", "fail"].map((name) => ({
        name,
        displayName: name,
        logic: [],
        parameters: [],
    })),
};
const invocation = (id: string, name = "increment"): ActionRequest => ({ id, name, parameters: {} });
const setup = Effect.fnUntraced(function* (maxCommits?: number) {
    const tables = yield* Memory.make();
    const options = {
        namespace: "owned-protocol",
        ir,
        tables,
        history: { maxCommits },
        mutators: Object.fromEntries(
            ["increment", "fail"].map((name) => [
                name,
                Effect.fnUntraced(function* (tx: import("./owned.js").OwnedTransaction) {
                    const previous = yield* tx.get("Counter", "one");
                    yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                    if (name === "fail")
                        return yield* new BackendError({
                            operation: "test",
                            kind: "ValidationFailed",
                            message: "Reject after write.",
                            retryable: false,
                        });
                }),
            ])
        ),
    };
    const backend = yield* makeOwnedBackend(options);
    return { tables, options, backend };
});

test("owned replay history is bounded and expired cursors require a coordinated snapshot", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup(2);
            const before = yield* f.backend.loadSubset(objectSubset("Counter"));
            for (let n = 1; n <= 5; n++) yield* f.backend.applyAction(invocation(`action-${n}`));
            expect(yield* Effect.result(f.backend.changes!.pull({ cursor: before.cursor }))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "HistoryExpired" },
            });
            const snapshot = yield* f.backend.loadSubset(objectSubset("Counter"));
            expect(snapshot.rows[0]?.value.count).toBe(5);
            expect((yield* f.backend.changes!.pull({ cursor: snapshot.cursor })).commits).toEqual([]);
            const journal = yield* f.tables.query(
                Table.make({ name: JSON.stringify(["backend", f.options.namespace, "journal"]) })
            );
            expect(journal.map((row) => row.key)).toEqual([4, 5]);
        })
    );
});

test("failed authority changes and receipts roll back, and successful receipts survive reopen", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup();
            expect(yield* Effect.result(f.backend.applyAction(invocation("bad", "fail")))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "ValidationFailed" },
            });
            expect((yield* f.backend.loadSubset(objectSubset("Counter"))).rows).toEqual([]);
            expect((yield* f.backend.changes!.pull({})).commits).toEqual([]);
            const committed = yield* f.backend.applyAction(invocation("good"));
            const reopened = yield* makeOwnedBackend(f.options);
            expect(yield* reopened.applyAction(invocation("good"))).toEqual(committed);
            expect((yield* reopened.loadSubset(objectSubset("Counter"))).rows[0]?.value.count).toBe(1);
            expect((yield* reopened.changes!.pull({})).commits).toHaveLength(1);
        })
    );
});

test("result and journal retention are independent of committed application rows", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const fixture = yield* setup();
            const backend = yield* makeOwnedBackend({
                ...fixture.options,
                resultRetentionMs: 100,
                history: { maxCommits: Infinity, maxAgeMs: 50 },
            });
            const before = yield* backend.loadSubset(objectSubset("Counter"));
            yield* backend.applyAction(invocation("one"));
            yield* backend.applyAction(invocation("one"));
            expect((yield* backend.loadSubset(objectSubset("Counter"))).rows[0]?.value.count).toBe(1);
            yield* TestClock.adjust(101);
            yield* backend.maintenance!;
            expect(
                yield* fixture.tables.query(
                    Table.make({ name: JSON.stringify(["backend", "owned-protocol", "receipts"]) })
                )
            ).toEqual([]);
            expect(yield* Effect.result(backend.changes!.pull({ cursor: before.cursor }))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "HistoryExpired" },
            });
            expect((yield* backend.loadSubset(objectSubset("Counter"))).rows[0]?.value.count).toBe(1);
            // Finite idempotency is explicit: after retention the same ID is a new invocation.
            yield* backend.applyAction(invocation("one"));
            expect((yield* backend.loadSubset(objectSubset("Counter"))).rows[0]?.value.count).toBe(2);
        }).pipe(Effect.provide(TestClock.layer()))
    );
});
