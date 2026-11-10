import { it } from "@effect/vitest";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Stream, Scope, Exit } from "effect";
import { expect } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { DeliveryFrame } from "@party-stack/ontology-backend/delivery";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

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
                { name: "n", displayName: "N", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};
const increment = Effect.fnUntraced(function* (tx: OwnedTransaction) {
    const row = yield* tx.get("Counter", "one");
    yield* tx.put("Counter", { id: "one", n: Number(row?.n ?? 0) + 1 });
});

it.effect("action-only replacement preserves an in-flight receipt and delivers a newly accepted action", () =>
    Effect.gen(function* () {
        const authority = yield* makeOwnedBackend({
            namespace: "interest-authority",
            ir,
            tables: yield* Memory.make(),
            mutators: { increment },
        });
        yield* authority.applyAction({ id: "seed", name: "increment", parameters: {} });
        const parent = yield* makeReplica({
            namespace: "interest-parent",
            ir,
            tables: yield* Memory.make(),
            backend: authority,
            execute: increment,
            startSync: false,
            objectCacheGc: false,
        });
        yield* parent.demand({ objectType: "Counter" });
        yield* parent.syncOnce;
        const actual = replicaStateSource(parent);
        const held = yield* Deferred.make<DeliveryFrame>();
        const hold = yield* Deferred.make<never>();
        const replayed = yield* Deferred.make<DeliveryFrame>();
        const acknowledged = yield* Deferred.make<void>();
        let armed = false,
            heldFrame: DeliveryFrame | undefined,
            latestGeneration = 0;
        const semanticAcks: { generation: number; current: number }[] = [];
        const source: OntologySource = {
            ...actual,
            acknowledge: (session, revision, through, generation) =>
                Effect.gen(function* () {
                    semanticAcks.push({ generation: generation ?? 0, current: latestGeneration });
                    yield* actual.acknowledge(session, revision, through, generation);
                    if (through >= 2) yield* Deferred.succeed(acknowledged, undefined);
                }),
            subscribe: (session, view, policy, resume) =>
                Effect.gen(function* () {
                    latestGeneration = view.generation;
                    const subscription = yield* actual.subscribe!(
                        session,
                        view,
                        { ...policy, frameRecords: 1 },
                        resume
                    );
                    let hasOldReceipt = false;
                    return {
                        ...subscription,
                        frames: subscription.frames.pipe(
                            Stream.tap((frame) =>
                                Effect.gen(function* () {
                                    if (frame.part === 0) hasOldReceipt = false;
                                    if (
                                        frame.changes.some(
                                            (change) =>
                                                change.kind === "put" &&
                                                change.record.kind === "completed" &&
                                                change.record.id === "old"
                                        )
                                    )
                                        hasOldReceipt = true;
                                    if (!frame.end) return;
                                    if (armed && hasOldReceipt && !heldFrame) {
                                        heldFrame = frame;
                                        yield* Deferred.succeed(held, frame);
                                        yield* Deferred.await(hold);
                                    } else if (
                                        heldFrame &&
                                        frame.streamId === heldFrame.streamId &&
                                        frame.sequence === heldFrame.sequence
                                    )
                                        yield* Deferred.succeed(replayed, frame);
                                })
                            )
                        ),
                    };
                }),
        };
        const child = yield* makeReplica({
            namespace: "interest-child",
            ir,
            tables: yield* Memory.make(),
            source,
            execute: increment,
            objectCacheGc: false,
        });
        yield* child.demand({ objectType: "Counter" });
        yield* child.syncSubset({ objectType: "Counter" });
        yield* child.enqueue({ id: "old", name: "increment", parameters: {} });
        yield* child.awaitAction("old", { until: "accepted" });
        armed = true;
        yield* parent.syncOnce;
        const original = yield* Deferred.await(held);
        yield* child.enqueue({ id: "new", name: "increment", parameters: {} });
        yield* child.awaitAction("new", { until: "accepted" });
        expect(yield* Deferred.await(replayed)).toEqual(original);
        const oldReceipt = yield* child.awaitAction("old", { until: "confirmed" });
        expect(oldReceipt?.operationId).toBe("old");
        expect((yield* child.actionStatus("new")).pending?.failure).toBeUndefined();
        expect((yield* child.actionStatus("new")).pending?.state).not.toBe("blocked");
        yield* parent.syncOnce;
        expect((yield* child.awaitAction("new", { until: "confirmed" }))?.operationId).toBe("new");
        expect((yield* child.loadSubset("Counter"))[0]?.value.n).toBe(3);
        expect((yield* authority.loadSubset(objectSubset("Counter"))).rows[0]?.value.n).toBe(3);
        yield* Deferred.await(acknowledged);
        expect(semanticAcks.length).toBeGreaterThan(0);
        expect(semanticAcks.every((ack) => ack.generation === ack.current)).toBe(true);
    })
);

it.effect.each(["changed row selection", "newer imported state"] as const)(
    "an older-interest target cannot overwrite %s",
    (reason) =>
        Effect.gen(function* () {
            const authority = yield* makeOwnedBackend({
                namespace: `interest-fence-authority-${reason}`,
                ir,
                tables: yield* Memory.make(),
                mutators: { increment },
            });
            yield* authority.applyAction({ id: "seed", name: "increment", parameters: {} });
            const parent = yield* makeReplica({
                namespace: `interest-fence-parent-${reason}`,
                ir,
                tables: yield* Memory.make(),
                backend: authority,
                execute: increment,
                startSync: false,
                objectCacheGc: false,
            });
            yield* parent.demand({ objectType: "Counter" });
            yield* parent.syncOnce;
            const source = replicaStateSource(parent);
            const child = yield* makeReplica({
                namespace: `interest-fence-child-${reason}`,
                ir,
                tables: yield* Memory.make(),
                source,
                execute: increment,
                startSync: false,
                objectCacheGc: false,
            });
            const oldScope = yield* Scope.fork(yield* Effect.scope);
            yield* Scope.provide(child.demand({ objectType: "Counter" }), oldScope);
            const opened = yield* child.openParentDelivery(source);
            const old = yield* opened.subscription.frames.pipe(
                Stream.takeUntil((frame) => frame.end),
                Stream.runCollect
            );
            if (reason === "changed row selection") {
                yield* Scope.close(oldScope, Exit.void);
                yield* child.demand({ objectType: "Counter", query: { where: eq(field("id"), "one") } });
            } else {
                yield* child.retainActions(["new"]);
                yield* authority.applyAction({ id: "remote", name: "increment", parameters: {} });
                yield* parent.syncOnce;
                yield* child.refreshParent(source);
                expect((yield* child.confirmed.get("Counter", "one"))?.n).toBe(2);
            }
            expect(yield* Effect.result(child.receiveDelivery(old.at(-1)!, opened.generation))).toMatchObject(
                {
                    _tag: "Failure",
                    failure: { kind: reason === "changed row selection" ? "ViewReplaced" : "HistoryExpired" },
                }
            );
            if (reason === "newer imported state")
                expect((yield* child.confirmed.get("Counter", "one"))?.n).toBe(2);
        })
);
