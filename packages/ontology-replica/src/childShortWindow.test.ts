import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { and, eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { expect } from "vitest";
import { makeReplica, replicaStateSource } from "./testing.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";
import type { Query } from "@party-stack/ontology-storage";

// A child replica (a browser tab under its SharedWorker, or any replica fed by a parent's
// delivery) applies the short-window rule to what its parent delivers: once a complete
// window arrives with fewer rows than its limit, reads of the same filter, such as a live
// query's boundary and continuation reads, are answered without asking the parent.

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

const fixture = (initial: readonly Item[]) =>
    Effect.gen(function* () {
        const truth = initial.map((value) => ({ key: value.id, value }));
        const owner = yield* makeReplica({
            namespace: "child-window-owner",
            ir,
            tables: yield* Memory.make(),
            execute: () => Effect.void,
            backend: makeOntologyBackend({
                ir,
                name: "upstream",
                sourceId: "upstream",
                supportsIdempotency: false,
                applyAction: () => Effect.die("Unexpected action"),
                queryFunction: () => Effect.void,
                loadSubset: (request) =>
                    Effect.map(compileObjectSubset(ir, request), (subset) => ({
                        complete: true,
                        rows: evaluateQuery(truth, subset.query ?? {}),
                    })),
            }),
        });
        // While held, the parent never hears about the child's new views: a read the
        // child cannot prove itself waits for good.
        let held = false;
        const stalled = yield* Deferred.make<never>();
        const parent = replicaStateSource(owner);
        const source: OntologySource = {
            ...parent,
            updateView: (session, view) =>
                held ? Deferred.await(stalled) : parent.updateView!(session, view),
            subscribe: (session, view, policy, resume) =>
                held ? Deferred.await(stalled) : parent.subscribe!(session, view, policy, resume),
        };
        const child = yield* makeReplica({
            namespace: "child-window-child",
            ir,
            tables: yield* Memory.make(),
            source,
            execute: () => Effect.void,
        });
        const read = (subset: CompiledSubset) =>
            Effect.gen(function* () {
                yield* child.demand(subset);
                yield* child.syncSubset(subset);
                return (yield* child.loadSubset(subset.objectType, subset.query)).map((row) => row.value);
            });
        const expected = (query: Query) => evaluateQuery(truth, query).map((row) => row.value);
        return {
            child,
            read,
            expected,
            hold: Effect.sync(() => {
                held = true;
            }),
        };
    });

it.live("a child answers the follow-up reads of a short delivered window itself", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const { read, expected, hold } = yield* fixture(items("aabab"));
            const first = yield* read(window("a", 10));
            expect(first).toEqual(expected(window("a", 10).query!));
            yield* hold;
            const last = first.at(-1) as Item;
            for (const followUp of [ties("a", last.rank), after("a", first[0] as Item, 10)]) {
                const rows = yield* read(followUp).pipe(Effect.timeoutOption("2 seconds"));
                expect(rows._tag).toBe("Some");
                expect(rows._tag === "Some" && rows.value).toEqual(expected(followUp.query!));
            }
        })
    )
);

it.live("a full delivered window still needs its parent for the rows beyond it", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const { read, hold } = yield* fixture(items("aaaaa"));
            const first = yield* read(window("a", 3));
            yield* hold;
            const continuation = yield* read(after("a", first.at(-1) as Item, 3)).pipe(
                Effect.timeoutOption("500 millis")
            );
            expect(continuation._tag).toBe("None");
        })
    )
);

const Scenario = Schema.Struct({
    groups: Schema.String.check(Schema.isPattern(/^[abc]{0,12}$/)),
    group: Schema.Literals(["a", "b", "c"]),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
    followUps: Schema.Array(
        Schema.Struct({
            kind: Schema.Literals(["ties", "after", "narrower", "window"]),
            at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
            limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
        })
    ).check(Schema.isMaxLength(5)),
});
const followUp = (
    scenario: typeof Scenario.Type,
    shown: readonly Item[],
    step: (typeof Scenario.Type)["followUps"][number]
): CompiledSubset => {
    const pivot = shown[step.at % Math.max(1, shown.length)];
    if (step.kind === "window") return window(scenario.group, step.limit);
    if (step.kind === "ties" || !pivot) return ties(scenario.group, pivot?.rank ?? step.at % 3);
    if (step.kind === "after") return after(scenario.group, pivot, step.limit);
    return {
        objectType: "Item",
        query: { where: and(eq(field("group"), scenario.group), eq(field("id"), pivot.id)) },
    };
};

// Safety: every follow-up read agrees with the backend. Progress: after a short window,
// follow-ups complete with the parent unreachable, while the child's view keeps changing.
it.live.prop(
    "a child's follow-up reads agree with the backend and need no parent after a short window",
    [Scenario],
    ([scenario]) =>
        Effect.scoped(
            Effect.gen(function* () {
                const { child, read, expected, hold } = yield* fixture(items(scenario.groups));
                const first = window(scenario.group, scenario.limit);
                const shown = (yield* read(first)) as Item[];
                const failures: string[] = [];
                if (JSON.stringify(shown) !== JSON.stringify(expected(first.query!)))
                    failures.push("window differs from the backend");
                const short = expected({ where: first.query!.where }).length < scenario.limit;
                if (short) yield* hold;
                // Unrelated view changes keep arriving while the follow-ups are read.
                const churn = yield* Effect.forkScoped(
                    Effect.forever(
                        Effect.gen(function* () {
                            const scope = yield* Scope.make();
                            yield* child.demand(window("c", 1)).pipe(Scope.provide(scope));
                            yield* Effect.sleep("3 millis");
                            yield* Scope.close(scope, Exit.void);
                        })
                    )
                );
                for (const step of scenario.followUps) {
                    const subset = followUp(scenario, shown, step);
                    const rows = yield* read(subset).pipe(Effect.timeoutOption("3 seconds"));
                    if (rows._tag === "None") failures.push(`${step.kind} read never completed`);
                    else if (JSON.stringify(rows.value) !== JSON.stringify(expected(subset.query!)))
                        failures.push(`${step.kind} read differs from the backend`);
                }
                yield* Fiber.interrupt(churn);
                if (failures.length) return yield* Effect.fail(new Error(failures.join("; ")));
                return true;
            })
        ),
    { arbitrary: { runs: 40, seed: "child-short-window-v1" }, timeout: 300_000 }
);
