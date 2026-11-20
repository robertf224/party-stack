import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Fiber, Stream } from "effect";
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
const lazySubscriptions = (source: OntologySource): OntologySource => ({
    ...source,
    subscribe: (session, view, policy, resume) =>
        Effect.sync(() => {
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
                            return subscription.frames;
                        }
                    )
                ),
                acknowledge: (position) => (opened ? opened.acknowledge(position) : Effect.void),
            };
        }),
});

// A child replica fed by its owner's client delivery, as a browser tab is by its worker.
// Each selection change replaces the child's subscription, and the owner holds a
// selection's demand only while a subscription selects it.
const handoff = (rapid: boolean) =>
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
            });
            const child = yield* makeReplica({
                namespace: "handoff-child",
                ir,
                tables: yield* Memory.make(),
                source: lazySubscriptions(replicaStateSource(owner)),
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
            if (rapid) yield* Effect.andThen(Effect.sleep("10 millis"), child.demand(groupC));
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

it.live("replacing a child's view does not restart the loads it still selects", () => handoff(false), 20_000);
it.live("rapid view changes do not restart the loads they still select", () => handoff(true), 20_000);
