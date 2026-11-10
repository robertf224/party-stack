import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table, type TablesService } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope, Stream } from "effect";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { ActionReceipt } from "@party-stack/ontology-backend";
import type { DeliveryRecord } from "@party-stack/ontology-backend/delivery";
import type { PendingAction } from "@party-stack/ontology-backend/protocol";

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
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};
const execute = Effect.fnUntraced(function* (tx: OwnedTransaction) {
    const previous = yield* tx.get("Counter", "one");
    yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
});
const outbox = Table.make<PendingAction & { includedInBase?: true }>({
    name: JSON.stringify(["replica", "receipt-child", "outbox"]),
});
const incomingChanges = JSON.stringify([
    JSON.stringify(["replica", "receipt-child", "upstream"]),
    "incoming-delivery",
    "changes",
]);
const base = (id: string, count: unknown): DeliveryRecord => ({
    kind: "base",
    objectType: "Counter",
    key: id,
    value: { id, count },
});

const fixture = Effect.fnUntraced(function* () {
    const storage = yield* Memory.make();
    const work = { active: false, deliveryPages: 0 };
    const tables: TablesService = {
        ...storage,
        transaction: (body) =>
            storage.transaction((tx) =>
                body({
                    ...tx,
                    query: new Proxy(tx.query, {
                        apply(target, thisArg, args) {
                            const [table] = args as Parameters<typeof tx.query>;
                            if (work.active && "name" in table && table.name === incomingChanges)
                                work.deliveryPages++;
                            return Reflect.apply(target, thisArg, args);
                        },
                    }),
                })
            ),
    };
    const parent = yield* makeReplica({
        namespace: "receipt-parent",
        tables: yield* Memory.make(),
        ir,
        startSync: false,
        execute,
        backend: yield* makeOwnedBackend({
            namespace: "receipt-authority",
            ir,
            tables: yield* Memory.make(),
            mutators: { increment: execute },
        }),
    });
    const source = replicaStateSource(parent);
    const child = yield* makeReplica({
        namespace: "receipt-child",
        ir,
        tables,
        source,
        startSync: false,
        execute,
    });
    const delivery = Effect.fnUntraced(function* () {
        // Bind test frames to a real client session and the current action selection.
        const connection = yield* Scope.fork(yield* Effect.scope);
        const opened = yield* Scope.provide(child.openParentDelivery(source), connection);
        const pull = yield* Scope.provide(Stream.toPull(opened.subscription.frames), connection);
        const metadata = (yield* pull)[0]!.metadata!;
        yield* Scope.close(connection, Exit.void);
        let revision = metadata.revision;
        return (records: readonly DeliveryRecord[]) =>
            child.receiveDelivery({
                streamId: crypto.randomUUID(),
                sequence: 1,
                previous: 0,
                part: 0,
                kind: "snapshot",
                changes: records.map((record) => ({ kind: "put", record })),
                end: true,
                metadata: {
                    ...metadata,
                    revision: ++revision,
                    coverage: [{ subset: { objectType: "Counter" }, complete: true }],
                },
            });
    });
    return { child, source, storage, work, delivery };
});

test("an empty outbox installs buffered delivery without reading per-record staging pages", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const deliver = yield* f.delivery();
                const rows = Array.from({ length: 130 }, (_, index) => base(`row-${index}`, index));
                f.work.active = true;
                yield* deliver(rows);
                f.work.active = false;
                expect((yield* f.child.loadSubset("Counter")).length).toBe(rows.length);
                // Frame traversal no longer round-trips each row through a staging table.
                expect(f.work.deliveryPages).toBe(0);
            })
        )
    );
});

test.each(["queued", "accepted"] as const)(
    "a %s local action keeps its committed receipt when delivery installation fails",
    async (state) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const f = yield* fixture();
                    const actionId = `receipt-${state}`;
                    yield* f.child.enqueue({ id: actionId, name: "increment", parameters: {} });
                    if (state === "accepted") {
                        yield* f.child.forwardParentActions(f.source);
                        expect(yield* f.child.pending).toEqual([]);
                    }
                    const local = yield* f.storage.read((tx) => tx.get(outbox, actionId));
                    expect(local).toBeDefined();
                    expect(local?.includedInBase).toBe(state === "accepted" ? true : undefined);
                    expect(local?.receipt).toBeUndefined();
                    const receipt: ActionReceipt = {
                        operationId: actionId,
                        outcome: "committed",
                        affected: [{ objectType: "Counter", keys: ["one"] }],
                    };
                    const completed: DeliveryRecord = {
                        kind: "completed",
                        id: actionId,
                        value: { ...local!, state: "acknowledged", receipt },
                    };
                    const deliver = yield* f.delivery();
                    // Receipt evidence must commit separately from fallible row decoding/rebase.
                    expect((yield* Effect.result(deliver([completed, base("one", "invalid")])))._tag).toBe(
                        "Failure"
                    );
                    expect(yield* f.storage.read((tx) => tx.get(outbox, actionId))).toMatchObject({
                        state: "acknowledged",
                        receipt,
                    });
                    // A later valid view can settle the same local action without resubmission.
                    yield* deliver([completed, base("one", 1)]);
                    expect(yield* f.child.receipt(actionId)).toEqual(receipt);
                    expect(yield* f.storage.read((tx) => tx.get(outbox, actionId))).toBeUndefined();
                })
            )
        );
    }
);
