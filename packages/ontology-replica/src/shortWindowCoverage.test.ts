import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { and, eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
import type { Query } from "@party-stack/ontology-storage";

// Ordered, limited live queries (TanStack DB's) follow a window with reads of the rows
// tied with its last row and of the rows after it. A complete window that came back
// short already holds every match, so those reads must be answered locally.

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
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
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
};
type Item = { id: string; group: string; rank: number };
const byRank = [{ field: field("rank"), direction: "asc" as const }];

const fixture = (initial: readonly Item[], options?: { readonly delay?: Effect.Effect<void> }) =>
    Effect.gen(function* () {
        const truth = new Map(initial.map((item) => [item.id, item]));
        const fetches: Query[] = [];
        const backend = makeOntologyBackend({
            ir,
            name: "short-window",
            sourceId: "short-window",
            supportsIdempotency: false,
            applyAction: () => Effect.die("Unexpected action"),
            queryFunction: () => Effect.void,
            loadSubset: (request) =>
                Effect.gen(function* () {
                    const subset = yield* compileObjectSubset(ir, request);
                    fetches.push(subset.query ?? {});
                    // Read before the latency, as a backend would.
                    const rows = evaluateQuery(
                        [...truth.values()].map((value) => ({ key: value.id, value })),
                        subset.query ?? {}
                    );
                    if (options?.delay) yield* options.delay;
                    return { complete: true, rows };
                }),
        });
        const replica = yield* makeReplica({
            namespace: "short-window",
            ir,
            tables: yield* Memory.make(),
            backend,
            execute: () => Effect.void,
        });
        const read = (subset: CompiledSubset) =>
            Effect.gen(function* () {
                yield* replica.demand(subset);
                yield* replica.syncSubset(subset);
                return (yield* replica.loadSubset(subset.objectType, subset.query)).map((row) => row.value);
            });
        const expected = (query: Query) =>
            evaluateQuery(
                [...truth.values()].map((value) => ({ key: value.id, value })),
                query
            ).map((row) => row.value);
        return { truth, fetches, replica, read, expected };
    });

const items = (groups: string): Item[] =>
    [...groups].map((group, index) => ({ id: `i${index}`, group, rank: index % 3 }));
const window = (group: string, limit: number): CompiledSubset => ({
    objectType: "Item",
    query: { where: eq(field("group"), group), orderBy: byRank, limit },
});
const ties = (group: string, rank: number): CompiledSubset => ({
    objectType: "Item",
    query: { where: and(eq(field("group"), group), eq(field("rank"), rank)), orderBy: byRank },
});
const after = (group: string, item: Item, limit: number): CompiledSubset => ({
    objectType: "Item",
    query: {
        where: eq(field("group"), group),
        orderBy: byRank,
        limit,
        after: { values: [item.rank], key: item.id },
    },
});

it.effect("a short window answers its boundary and continuation reads without fetching", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const { fetches, read, expected } = yield* fixture(items("aabab"));
            const first = yield* read(window("a", 10));
            expect(first).toEqual(expected(window("a", 10).query!));
            expect(fetches).toHaveLength(1);
            const last = first.at(-1) as Item;
            expect(yield* read(ties("a", last.rank))).toEqual(expected(ties("a", last.rank).query!));
            expect(yield* read(after("a", first[0] as Item, 10))).toEqual(
                expected(after("a", first[0] as Item, 10).query!)
            );
            expect(fetches).toHaveLength(1);
        })
    )
);

it.effect("a full window still fetches the rows beyond it", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const { fetches, read, expected } = yield* fixture(items("aaaaa"));
            const first = yield* read(window("a", 3));
            expect(fetches).toHaveLength(1);
            const continuation = after("a", first.at(-1) as Item, 3);
            expect(yield* read(continuation)).toEqual(expected(continuation.query!));
            expect(fetches.length).toBeGreaterThan(1);
        })
    )
);

it.effect("a short window after a cursor proves only the rows after it", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const all = items("aaaa");
            const { read, expected } = yield* fixture(all);
            const pivot = expected(window("a", 10).query!)[1] as Item;
            yield* read(after("a", pivot, 10));
            expect(yield* read(window("a", 10))).toEqual(expected(window("a", 10).query!));
        })
    )
);

it.effect("a short window over the whole collection drops cached rows it no longer returns", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const { truth, read, expected } = yield* fixture(items("ab"));
            yield* read({ objectType: "Item", query: { where: eq(field("id"), "i1") } });
            truth.delete("i1");
            const whole: CompiledSubset = { objectType: "Item", query: { orderBy: byRank, limit: 10 } };
            yield* read(whole);
            expect(yield* read({ objectType: "Item" })).toEqual(expected({}));
        })
    )
);

const Scenario = Schema.Struct({
    groups: Schema.String.check(Schema.isPattern(/^[abc]{0,12}$/)),
    group: Schema.Literals(["a", "b", "c"]),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
    /** Open the window after this row instead of at the start. */
    startAfter: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))),
    followUps: Schema.Array(
        Schema.Struct({
            kind: Schema.Literals(["ties", "after", "narrower", "window"]),
            at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
            limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
        })
    ).check(Schema.isMaxLength(6)),
});
const followUp = (
    scenario: typeof Scenario.Type,
    shown: readonly Item[],
    step: (typeof Scenario.Type)["followUps"][number]
): CompiledSubset => {
    const pivot = shown[step.at % Math.max(1, shown.length)];
    if (step.kind === "ties" || !pivot) return ties(scenario.group, pivot?.rank ?? step.at % 3);
    if (step.kind === "window") return window(scenario.group, step.limit);
    if (step.kind === "after") return after(scenario.group, pivot, step.limit);
    return {
        objectType: "Item",
        query: { where: and(eq(field("group"), scenario.group), eq(field("id"), pivot.id)) },
    };
};

it.effect.prop(
    "follow-up reads of a window agree with the backend and fetch only beyond a full window",
    [Scenario],
    ([scenario]) =>
        Effect.scoped(
            Effect.gen(function* () {
                const all = items(scenario.groups);
                const { fetches, read, expected } = yield* fixture(all);
                const start = scenario.startAfter === undefined ? undefined : all[scenario.startAfter];
                const first = start
                    ? after(scenario.group, start, scenario.limit)
                    : window(scenario.group, scenario.limit);
                const shown = (yield* read(first)) as Item[];
                const failures: string[] = [];
                if (JSON.stringify(shown) !== JSON.stringify(expected(first.query!)))
                    failures.push("window differs from the backend");
                const matches = expected({ where: first.query!.where }).length;
                for (const step of scenario.followUps) {
                    const subset = followUp(scenario, shown, step);
                    const before = fetches.length;
                    const rows = yield* read(subset);
                    if (JSON.stringify(rows) !== JSON.stringify(expected(subset.query!)))
                        failures.push(`${step.kind} read differs from the backend`);
                    if (!start && matches < scenario.limit && fetches.length !== before)
                        failures.push(`${step.kind} read fetched although the window held every match`);
                }
                // A typed failure keeps the violated invariant in the shrunk report.
                if (failures.length) return yield* Effect.fail(new Error(failures.join("; ")));
                return true;
            })
        ),
    { arbitrary: { runs: 200, seed: "short-window-coverage-v1" }, timeout: 120_000 }
);

// Progress: follow-up reads complete while the backend keeps changing and every proof
// keeps being marked due for revalidation, with fetches that take real time.
it.live.prop(
    "follow-up reads complete while edits and revalidations keep arriving",
    [Scenario],
    ([scenario]) =>
        Effect.scoped(
            Effect.gen(function* () {
                const { truth, replica, read } = yield* fixture(items(scenario.groups), {
                    delay: Effect.sleep("3 millis"),
                });
                const first = window(scenario.group, scenario.limit);
                const shown = (yield* read(first)) as Item[];
                const stop = yield* Deferred.make<void>();
                let edit = 0;
                const interference = yield* Effect.forkScoped(
                    Effect.gen(function* () {
                        while (!(yield* Deferred.isDone(stop))) {
                            const id = `i${edit++ % Math.max(1, truth.size)}`;
                            const item = truth.get(id);
                            if (item) truth.set(id, { ...item, group: item.group === "a" ? "b" : "a" });
                            yield* replica.markDemandedStale;
                            yield* Effect.sleep("2 millis");
                        }
                    })
                );
                for (const step of scenario.followUps) {
                    const done = yield* read(followUp(scenario, shown, step)).pipe(
                        Effect.timeoutOption("3 seconds")
                    );
                    if (done._tag === "None")
                        return yield* Effect.fail(new Error(`${step.kind} read never completed`));
                }
                yield* Deferred.succeed(stop, undefined);
                yield* Fiber.join(interference);
                return true;
            })
        ),
    { arbitrary: { runs: 25, seed: "short-window-progress-v1" }, timeout: 120_000 }
);
