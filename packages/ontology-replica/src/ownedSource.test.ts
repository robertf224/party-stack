import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./index.js";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { ClientSubmission, OntologySource } from "@party-stack/ontology-backend/protocol";

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
    actionTypes: [{ name: "increment", displayName: "Increment", logic: [], parameters: [] }],
};
const execute = Effect.fnUntraced(function* (tx: OwnedTransaction) {
    const previous = yield* tx.get("Counter", "one");
    yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
});
const action = (id: string): ActionRequest => ({ id, name: "increment", parameters: {} });

test("the ordinary memory Replica connects directly to owned storage and preserves receipts after source compaction", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "source",
                    tables: yield* Memory.make(),
                    ir,
                    mutators: { increment: execute },
                });
                const child = yield* makeReplica({
                    namespace: "child",
                    tables: yield* Memory.make(),
                    ir,
                    source: owned.protocol,
                    execute,
                    startSync: false,
                    gc: false,
                });
                yield* child.retainLocal("Counter");
                yield* child.refreshParent(owned.protocol);
                for (let sequence = 1; sequence <= 10; sequence++) {
                    const id = `action-${sequence}`;
                    yield* child.enqueue(action(id));
                    expect((yield* child.get("Counter", "one"))?.count).toBe(sequence);
                    yield* child.syncOnce;
                    yield* child.syncOnce;
                    expect(yield* child.pending).toEqual([]);
                    expect((yield* child.confirmed.get("Counter", "one"))?.count).toBe(sequence);
                    expect((yield* child.actionStatus(id)).receipt?.outcome).toBe("committed");
                    expect((yield* child.parentState)?.pending).toEqual([]);
                    expect((yield* child.parentState)?.completed).toEqual([]);
                }
                expect((yield* owned.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(10);
            })
        )
    );
});

test("lost owned-source replies recover from committed state without repeating the mutator", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "source",
                    tables: yield* Memory.make(),
                    ir,
                    mutators: { increment: execute },
                });
                let submissions = 0;
                const source: OntologySource = {
                    ...owned.protocol,
                    submit: Effect.fnUntraced(function* (request: ClientSubmission) {
                        submissions++;
                        yield* owned.protocol.submit(request);
                        return yield* new BackendError({
                            operation: "transport",
                            kind: "Unavailable",
                            message: "Reply lost.",
                            retryable: true,
                        });
                    }),
                };
                const child = yield* makeReplica({
                    namespace: "child",
                    tables: yield* Memory.make(),
                    ir,
                    source,
                    execute,
                    startSync: false,
                    gc: false,
                });
                yield* child.retainLocal("Counter");
                yield* child.refreshParent(source);
                yield* child.enqueue(action("one"));
                expect((yield* Effect.result(child.syncOnce))._tag).toBe("Failure");
                expect((yield* child.pending)[0]?.state).toBe("queued");
                yield* child.syncOnce;
                expect(submissions).toBe(1);
                expect(yield* child.pending).toEqual([]);
                expect((yield* child.get("Counter", "one"))?.count).toBe(1);
                expect((yield* child.receipt("one"))?.outcome).toBe("committed");
            })
        )
    );
});
