import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { makeReplica } from "./testing.js";

const objectType = (name: string) => ({
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    primaryKey: "id",
    properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
});
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [],
    objectTypes: [objectType("Item"), objectType("Tag")],
};
const rows = [
    { key: "one", value: { id: "one" } },
    { key: "two", value: { id: "two" } },
];

const fixture = Effect.fnUntraced(function* (options: { hold?: boolean }) {
    const started = { Item: yield* Deferred.make<void>(), Tag: yield* Deferred.make<void>() };
    const release = yield* Deferred.make<void>();
    const loads: string[] = [];
    const inFlight = new Map<string, number>();
    let maxInFlightPerType = 0;
    const replica = yield* makeReplica({
        namespace: "concurrent-loads",
        ir,
        tables: yield* Memory.make(),
        startSync: false,
        objectCacheGc: false,
        execute: () => Effect.void,
        backend: makeOntologyBackend({
            ir,
            name: "fixture",
            sourceId: "fixture",
            supportsIdempotency: false,
            refresh: () => ({ pollIntervalMs: false }),
            queryFunction: () => Effect.void,
            applyAction: (request) =>
                Effect.succeed({ operationId: request.id, outcome: "committed", affected: [] }),
            loadSubset: (request) =>
                Effect.flatMap(compileObjectSubset(ir, request), (subset) =>
                    Effect.gen(function* () {
                        const type = subset.objectType as "Item" | "Tag";
                        loads.push(type);
                        const active = (inFlight.get(type) ?? 0) + 1;
                        inFlight.set(type, active);
                        maxInFlightPerType = Math.max(maxInFlightPerType, active);
                        yield* Deferred.succeed(started[type], undefined);
                        if (options.hold) yield* Deferred.await(release);
                        inFlight.set(type, active - 1);
                        return { rows: evaluateQuery(rows, subset.query), complete: true };
                    })
                ),
        }),
    });
    return {
        replica,
        started,
        release,
        loads,
        maxInFlightPerType: () => maxInFlightPerType,
    };
});

test("one sync pass loads different object types concurrently", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica, started, release } = yield* fixture({ hold: true });
                yield* replica.demand({ objectType: "Item" });
                yield* replica.demand({ objectType: "Tag" });
                const sync = yield* Effect.forkScoped(replica.syncOnce);
                // Both loads are in flight before either finishes; a sequential pass
                // never starts the second type while the first is held.
                yield* Effect.all([Deferred.await(started.Item), Deferred.await(started.Tag)]).pipe(
                    Effect.timeout(1_000)
                );
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(sync);
                expect(yield* replica.get("Item", "one")).toEqual({ id: "one" });
                expect(yield* replica.get("Tag", "two")).toEqual({ id: "two" });
            })
        )
    );
});

test("one object type still loads in order so a loaded superset covers later demands", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const { replica, loads, maxInFlightPerType } = yield* fixture({});
                yield* replica.demand({ objectType: "Item" });
                yield* replica.demand({ objectType: "Item", query: { where: eq(field("id"), "one") } });
                yield* replica.demand({ objectType: "Tag" });
                yield* replica.syncOnce;
                expect(loads.filter((type) => type === "Item")).toEqual(["Item"]);
                expect(maxInFlightPerType()).toBe(1);
                const status = yield* replica.status;
                expect(status.demands.every((demand) => demand.loadError === undefined)).toBe(true);
                expect(yield* replica.get("Item", "one")).toEqual({ id: "one" });
            })
        )
    );
});
