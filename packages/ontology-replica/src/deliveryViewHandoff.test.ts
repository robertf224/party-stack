import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { expect } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { DeliverySubscription } from "@party-stack/ontology-backend/delivery";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "group", displayName: "Group", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [],
};
const rows = [
    { id: "a1", group: "a" },
    { id: "b1", group: "b" },
    { id: "c1", group: "c" },
];
const groupA = { objectType: "Item", query: { where: eq(field("group"), "a") } };
const groupB = { objectType: "Item", query: { where: eq(field("group"), "b") } };
const groupC = { objectType: "Item", query: { where: eq(field("group"), "c") } };

// Like an RPC client: subscribing returns at once, and the parent opens the subscription,
// acquiring its demand, only once its frames are consumed.
const lazySubscriptions = (
    source: OntologySource,
    inPlace: boolean,
    subscribed?: () => void
): OntologySource => ({
    ...source,
    // Without in-place updates the child replaces its subscription on every view change.
    updateView: inPlace ? source.updateView : undefined,
    subscribe: (session, view, policy, resume) =>
        Effect.sync(() => {
            subscribed?.();
            let opened: DeliverySubscription | undefined;
            return {
                frames: Stream.unwrap(
                    // A round trip before the parent opens it.
                    Effect.map(
                        Effect.andThen(
                            Effect.sleep("30 millis"),
                            source.subscribe!(session, view, policy, resume)
                        ),
                        (subscription) => {
                            opened = subscription;
                            // Frames take time to cross too, so a view can change while a
                            // frame captured for the previous one is still on its way.
                            return subscription.frames.pipe(Stream.tap(() => Effect.sleep("20 millis")));
                        }
                    )
                ),
                acknowledge: (position) => (opened ? opened.acknowledge(position) : Effect.void),
            };
        }),
});

// A child replica fed by its owner's client delivery, as a browser tab is by its worker.
// The owner holds a selection's demand only while a subscription selects it. A view
// change either edits the open subscription in place, keeping the demand both views
// share, or replaces it, relying on idle retention to bridge the gap.
const handoff = (options: { rapid: boolean; inPlace: boolean; idleRetentionMs?: number }) =>
    Effect.scoped(
        Effect.gen(function* () {
            const fetches = new Map<string, number>();
            const release = yield* Deferred.make<void>();
            const upstream = makeOntologyBackend({
                ir,
                name: "upstream",
                sourceId: "upstream",
                supportsIdempotency: false,
                queryFunction: () => Effect.void,
                applyAction: (request) => Effect.succeed({ operationId: request.id, outcome: "committed" }),
                loadSubset: (request) =>
                    Effect.gen(function* () {
                        const subset = yield* compileObjectSubset(ir, request);
                        const key = JSON.stringify(subset.query?.where ?? null);
                        fetches.set(key, (fetches.get(key) ?? 0) + 1);
                        yield* Deferred.await(release);
                        return {
                            complete: true,
                            rows: evaluateQuery(
                                rows.map((value) => ({ key: value.id, value })),
                                subset.query ?? {}
                            ),
                        };
                    }),
            });
            const owner = yield* makeReplica({
                namespace: "handoff-owner",
                ir,
                tables: yield* Memory.make(),
                backend: upstream,
                execute: () => Effect.void,
                demand:
                    options.idleRetentionMs === undefined
                        ? undefined
                        : { idleRetentionMs: options.idleRetentionMs },
            });
            const child = yield* makeReplica({
                namespace: "handoff-child",
                ir,
                tables: yield* Memory.make(),
                source: lazySubscriptions(replicaStateSource(owner), options.inPlace),
                execute: () => Effect.void,
            });
            const fetchesOf = (subset: typeof groupA) => fetches.get(JSON.stringify(subset.query.where)) ?? 0;
            const until = (condition: () => boolean, label: string) =>
                Effect.gen(function* () {
                    for (let waited = 0; waited < 5_000; waited += 10) {
                        if (condition()) return;
                        yield* Effect.sleep("10 millis");
                    }
                    return yield* Effect.die(new Error(`${label}; fetches ${JSON.stringify([...fetches])}`));
                });

            yield* child.demand(groupA);
            const read = yield* Effect.forkScoped(child.syncSubset(groupA));
            yield* until(() => fetchesOf(groupA) === 1, "group A never fetched");
            // The view gains a subset while group A's fetch is still in flight. Rapid:
            // another change follows before the replacement has delivered anything.
            yield* child.demand(groupB);
            if (options.rapid) yield* Effect.andThen(Effect.sleep("10 millis"), child.demand(groupC));
            yield* until(() => fetchesOf(groupB) === 1, "group B never fetched");
            yield* Effect.sleep("100 millis");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(read);
            yield* child.syncSubset(groupB);

            expect(yield* child.get("Item", "a1")).toMatchObject({ id: "a1" });
            expect(yield* child.get("Item", "b1")).toMatchObject({ id: "b1" });
            // Group A's fetch survives the view change instead of starting again.
            expect(fetchesOf(groupA)).toBe(1);
            expect(fetchesOf(groupB)).toBe(1);
        })
    );

it.live(
    "an in-place view change keeps the loads both views select, without idle retention",
    () => handoff({ rapid: false, inPlace: true, idleRetentionMs: 0 }),
    20_000
);
it.live(
    "rapid in-place view changes keep the loads they still select",
    () => handoff({ rapid: true, inPlace: true, idleRetentionMs: 0 }),
    20_000
);
it.live(
    "replacing a child's view reuses its loads within the default idle retention",
    () => handoff({ rapid: false, inPlace: false }),
    20_000
);
it.live(
    "rapid replaced views reuse their loads within the default idle retention",
    () => handoff({ rapid: true, inPlace: false }),
    20_000
);

// Views keep changing while selected subsets are still loading. In place, the child keeps
// one subscription, never fetches a subset again while some view still selects it, and
// every read of a selected subset completes while later changes keep arriving.
const Step = Schema.Struct({
    group: Schema.Literals(["a", "b", "c"]),
    select: Schema.Boolean,
    pauseMs: Schema.Literals([0, 5, 40]),
});
it.live.prop(
    "in-place view changes keep one subscription, never refetch a selected subset and keep reads completing",
    [Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(10))],
    ([steps]) =>
        Effect.scoped(
            Effect.gen(function* () {
                const fetches = new Map<string, number>();
                const upstream = makeOntologyBackend({
                    ir,
                    name: "upstream",
                    sourceId: "upstream",
                    supportsIdempotency: false,
                    queryFunction: () => Effect.void,
                    applyAction: (request) =>
                        Effect.succeed({ operationId: request.id, outcome: "committed" }),
                    loadSubset: (request) =>
                        Effect.gen(function* () {
                            const subset = yield* compileObjectSubset(ir, request);
                            const key = JSON.stringify(subset.query?.where ?? null);
                            fetches.set(key, (fetches.get(key) ?? 0) + 1);
                            yield* Effect.sleep("30 millis");
                            return {
                                complete: true,
                                rows: evaluateQuery(
                                    rows.map((value) => ({ key: value.id, value })),
                                    subset.query ?? {}
                                ),
                            };
                        }),
                });
                const owner = yield* makeReplica({
                    namespace: "churn-owner",
                    ir,
                    tables: yield* Memory.make(),
                    backend: upstream,
                    execute: () => Effect.void,
                    demand: { idleRetentionMs: 0 },
                });
                let subscriptions = 0;
                const child = yield* makeReplica({
                    namespace: "churn-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: lazySubscriptions(replicaStateSource(owner), true, () => subscriptions++),
                    execute: () => Effect.void,
                });
                const groups = { a: groupA, b: groupB, c: groupC };
                const held = new Map<string, Scope.Closeable>();
                const failures: string[] = [];
                const reads: Fiber.Fiber<boolean>[] = [];
                // Selected continuously since its first fetch: a second fetch is a restart.
                const continuous = new Set<string>();
                for (const step of steps) {
                    const subset = groups[step.group];
                    const lease = held.get(step.group);
                    if (step.select && !lease) {
                        const scope = yield* Scope.make();
                        yield* child.demand(subset).pipe(Scope.provide(scope));
                        held.set(step.group, scope);
                        continuous.add(step.group);
                        reads.push(
                            yield* Effect.forkScoped(
                                child.syncSubset(subset).pipe(
                                    Effect.timeoutOption("3 seconds"),
                                    Effect.map((done) => done._tag === "Some"),
                                    Effect.orElseSucceed(() => false)
                                )
                            )
                        );
                    } else if (!step.select && lease) {
                        held.delete(step.group);
                        continuous.delete(step.group);
                        yield* Scope.close(lease, Exit.void);
                    }
                    for (const group of continuous)
                        if ((fetches.get(JSON.stringify(groups[group as "a"].query.where)) ?? 0) > 1)
                            failures.push(`group ${group} was fetched again while selected`);
                    if (step.pauseMs) yield* Effect.sleep(step.pauseMs);
                }
                for (const read of reads)
                    if (!(yield* Fiber.join(read)))
                        failures.push("a read of a selected subset never completed");
                for (const [group] of held) {
                    const id = `${group}1`;
                    if ((yield* child.get("Item", id)) === undefined) failures.push(`${id} missing`);
                }
                if (subscriptions !== 1) failures.push(`subscribed ${subscriptions} times`);
                for (const scope of held.values()) yield* Scope.close(scope, Exit.void);
                if (failures.length) return yield* Effect.fail(new Error([...new Set(failures)].join("; ")));
                return true;
            })
        ),
    { arbitrary: { runs: 25, seed: "delivery-view-churn-v1" }, timeout: 120_000 }
);
