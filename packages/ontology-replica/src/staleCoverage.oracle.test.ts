import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { CompiledSubset } from "@party-stack/ontology-backend/subset";

// Oracle: the source's own history. Under any interleaving of source edits, clock
// jumps, poll ticks, held loads, held action dispatches and reads, a read that
// resolves must return, row by row, the source state at some instant inside its
// freshness bound: `maxCoverageAgeMs` for a fresh proof, `maxStaleAgeMs` for a stale
// one. A row's confirmed version never moves backwards, and once everything is
// released the replica converges to the source.

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
                { name: "value", displayName: "Value", type: o.integer({}) },
                { name: "group", displayName: "Group", type: o.string({}) },
                { name: "version", displayName: "Version", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "increment",
            displayName: "Increment",
            parameters: [{ name: "id", displayName: "ID", type: o.string({}) }],
            logic: [],
        },
    ],
};
type Item = { id: string; value: number; group: string; version: number };
const ids = ["i0", "i1", "i2"] as const;
const subsets: Record<string, CompiledSubset> = {
    whole: { objectType: "Item" },
    groupA: { objectType: "Item", query: { where: eq(field("group"), "a") } },
    point: { objectType: "Item", query: { where: eq(field("id"), "i0") } },
};
const maxCoverageAgeMs = 1_000;
const maxStaleAgeMs = 5_000;
const pollIntervalMs = 2_000;

const Id = Schema.Literals(ids);
const Operation = Schema.Union([
    Schema.Struct({
        kind: Schema.Literal("edit"),
        id: Id,
        value: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
        group: Schema.Literals(["a", "b"]),
    }),
    Schema.Struct({ kind: Schema.Literal("advance"), ms: Schema.Literals([0, 1_200, 3_000, 8_000]) }),
    Schema.Struct({ kind: Schema.Literal("read"), subset: Schema.Literals(["whole", "groupA", "point"]) }),
    // Later loads or action dispatches block until `release`.
    Schema.Struct({ kind: Schema.Literal("hold"), what: Schema.Literals(["loads", "actions"]) }),
    Schema.Struct({ kind: Schema.Literal("release") }),
    // A sync pass in the background: pull, load and dispatch the outbox.
    Schema.Struct({ kind: Schema.Literal("pass") }),
    Schema.Struct({ kind: Schema.Literal("revalidate") }),
    Schema.Struct({ kind: Schema.Literal("increment"), id: Id }),
]);
const Scenario = Schema.Struct({
    stale: Schema.Boolean,
    poll: Schema.Boolean,
    operations: Schema.Array(Operation).check(Schema.isMinLength(6), Schema.isMaxLength(24)),
});

const run = (scenario: typeof Scenario.Type) =>
    Effect.scoped(
        Effect.gen(function* () {
            const bound = scenario.stale ? maxStaleAgeMs : maxCoverageAgeMs;
            let version = 0;
            const server = new Map<string, Item>();
            // Every state each row has had, with the time it began.
            const history = new Map<string, Array<{ time: number; row: Item | undefined }>>(
                ids.map((id) => [id, [{ time: 0, row: undefined }]])
            );
            const write = Effect.fnUntraced(function* (row: Omit<Item, "version">) {
                const next = { ...row, version: ++version };
                server.set(row.id, next);
                history.get(row.id)!.push({ time: yield* Clock.currentTimeMillis, row: next });
            });
            yield* write({ id: "i0", value: 0, group: "a" });
            yield* write({ id: "i1", value: 0, group: "b" });
            const holds = {
                loads: undefined as Deferred.Deferred<void> | undefined,
                actions: undefined as Deferred.Deferred<void> | undefined,
            };
            const backend = makeOntologyBackend({
                ir,
                name: "stale-oracle",
                sourceId: "stale-oracle",
                supportsIdempotency: false,
                queryFunction: () => Effect.void,
                refresh: () => ({ pollIntervalMs: scenario.poll ? pollIntervalMs : false }),
                loadSubset: (request) =>
                    Effect.gen(function* () {
                        const subset = yield* compileObjectSubset(ir, request);
                        if (holds.loads) yield* Deferred.await(holds.loads);
                        // Read the source when the fetch completes.
                        return {
                            complete: true,
                            rows: evaluateQuery(
                                [...server.values()].map((row) => ({ key: row.id, value: { ...row } })),
                                subset.query ?? {}
                            ),
                        };
                    }),
                applyAction: (request) =>
                    Effect.gen(function* () {
                        if (holds.actions) yield* Deferred.await(holds.actions);
                        const id = String(request.parameters.id);
                        const row = server.get(id);
                        if (row) yield* write({ ...row, value: row.value + 1 });
                        return {
                            operationId: request.id,
                            outcome: "committed" as const,
                            affected: row ? [{ objectType: "Item", keys: [id] }] : [],
                        };
                    }),
            });
            const replica = yield* makeReplica({
                namespace: "stale-oracle",
                ir,
                tables: yield* Memory.make(),
                backend,
                startSync: false,
                objectCacheGc: false,
                demand: { refresh: { maxCoverageAgeMs, maxStaleAgeMs: scenario.stale ? maxStaleAgeMs : 0 } },
                execute: (tx, action) =>
                    Effect.gen(function* () {
                        const row = yield* tx.get("Item", String(action.parameters.id));
                        if (row) yield* tx.put("Item", { ...row, value: Number(row.value) + 1 });
                    }),
            });

            let violation: string | undefined;
            const fail = (message: string) => {
                violation ??= message;
            };
            const project = (subset: CompiledSubset, row: Item | undefined) =>
                row && evaluateQuery([{ key: row.id, value: row }], subset.query ?? {}).length
                    ? row
                    : undefined;
            // Some state of this row, as the subset sees it, held at an instant in (now - age, now].
            const recent = (
                id: string,
                subset: CompiledSubset,
                observed: Item | undefined,
                now: number,
                age: number
            ) => {
                const states = history.get(id)!;
                return states.some((state, index) => {
                    const end = states[index + 1]?.time ?? Infinity;
                    return (
                        state.time <= now &&
                        end > now - age &&
                        JSON.stringify(project(subset, state.row)) === JSON.stringify(observed)
                    );
                });
            };
            const demanded = new Set<string>();
            // Status reports canonical queries; recognize the three fixture subsets.
            const subsetName = (entry: { readonly query?: { readonly where?: unknown } }) => {
                const where = JSON.stringify(entry.query?.where ?? null);
                return where === "null" ? "whole" : where.includes('"group"') ? "groupA" : "point";
            };
            const reads: Array<Fiber.Fiber<void, unknown>> = [];
            const read = (name: string) =>
                Effect.gen(function* () {
                    const subset = subsets[name]!;
                    if (!demanded.has(name)) {
                        demanded.add(name);
                        yield* replica.demand(subset);
                    }
                    const fiber = yield* Effect.forkScoped(
                        Effect.gen(function* () {
                            const synced = yield* Effect.result(replica.syncSubset(subset));
                            if (synced._tag === "Failure")
                                return fail(`${name}: read failed ${synced.failure.kind}`);
                            const now = yield* Clock.currentTimeMillis;
                            const demand = (yield* replica.status).demands.find(
                                (entry) => subsetName(entry) === name
                            );
                            const proof = demand?.coverageProof;
                            const rows = new Map(
                                (yield* replica.snapshotSubset({
                                    ...subset,
                                    query: subset.query ?? {},
                                })).rows.map((row) => [String(row.key), row.value as Item])
                            );
                            if (proof?.stale && !(now - proof.confirmedAt! < maxStaleAgeMs))
                                fail(
                                    `${name}: stale proof confirmed at ${proof.confirmedAt} served at ${now}`
                                );
                            if (proof?.stale && !scenario.stale)
                                fail(`${name}: stale proof without maxStaleAgeMs`);
                            const age = proof && !proof.stale ? maxCoverageAgeMs : bound;
                            for (const id of ids)
                                if (!recent(id, subset, rows.get(id), now, age))
                                    fail(
                                        `${name}: ${id} ${JSON.stringify(rows.get(id))} outside ${age} ms at ${now}`
                                    );
                        })
                    );
                    reads.push(fiber);
                });
            const passes: Array<Fiber.Fiber<unknown>> = [];
            const seen = new Map<string, number>();
            const monotonic = Effect.gen(function* () {
                for (const id of ids) {
                    const row = (yield* replica.confirmed.get("Item", id)) as Item | undefined;
                    if (!row) continue;
                    if (row.version < (seen.get(id) ?? 0)) fail(`${id}: version ${row.version} regressed`);
                    seen.set(id, Math.max(row.version, seen.get(id) ?? 0));
                }
            });
            // Let forked reads, passes and background fibers run at the current instant.
            const progress = Effect.gen(function* () {
                for (let step = 0; step < 40; step++) {
                    yield* TestClock.adjust(0);
                    yield* Effect.yieldNow;
                }
            });
            const release = Effect.gen(function* () {
                for (const what of ["loads", "actions"] as const) {
                    const held = holds[what];
                    holds[what] = undefined;
                    if (held) yield* Deferred.succeed(held, undefined);
                }
            });
            let sequence = 0;
            for (const operation of scenario.operations) {
                if (operation.kind === "edit")
                    yield* write({ id: operation.id, value: operation.value, group: operation.group });
                else if (operation.kind === "advance") yield* TestClock.adjust(operation.ms);
                else if (operation.kind === "read") yield* read(operation.subset);
                else if (operation.kind === "hold") holds[operation.what] ??= yield* Deferred.make<void>();
                else if (operation.kind === "release") yield* release;
                else if (operation.kind === "pass")
                    passes.push(yield* Effect.forkScoped(Effect.result(replica.syncOnce)));
                else if (operation.kind === "revalidate") yield* replica.markDemandedStale;
                else {
                    const known = (yield* replica.get("Item", operation.id)) !== undefined;
                    if (known)
                        yield* replica.enqueue({
                            id: `increment-${sequence++}`,
                            name: "increment",
                            parameters: { id: operation.id },
                        });
                }
                yield* progress;
                yield* monotonic;
                // A pass that nothing obstructs revalidates every stale proof it served.
                if (
                    operation.kind === "pass" &&
                    !holds.loads &&
                    !holds.actions &&
                    passes.every((fiber) => fiber.pollUnsafe() !== undefined)
                )
                    for (const demand of (yield* replica.status).demands)
                        if (demand.coverageProof?.stale)
                            fail(`${subsetName(demand)}: still stale after an unobstructed pass`);
                if (violation) break;
            }
            // Everything released, every read and pass completes.
            yield* release;
            yield* progress;
            for (const fiber of [...reads, ...passes]) yield* Fiber.join(fiber);
            yield* monotonic;
            // After a full refresh with nothing held, every demand shows the source.
            yield* TestClock.adjust(maxStaleAgeMs * 2);
            yield* replica.syncOnce;
            yield* replica.syncOnce;
            for (const name of demanded) {
                const subset = subsets[name]!;
                yield* replica.syncSubset(subset);
                const rows = (yield* replica.snapshotSubset({ ...subset, query: subset.query ?? {} })).rows;
                const expected = ids.flatMap((id) => {
                    const row = project(subset, server.get(id));
                    return row ? [row] : [];
                });
                if (
                    JSON.stringify(
                        rows
                            .map((row) => row.value)
                            .sort((a, b) => String((a as Item).id).localeCompare(String((b as Item).id)))
                    ) !== JSON.stringify(expected)
                )
                    fail(`${name}: did not converge`);
            }
            if (violation) yield* Effect.logWarning("Stale coverage oracle violation", { violation });
            return violation === undefined;
        })
    );

it.effect.prop(
    "reads stay within their freshness bound under loads, polls, revalidation and actions",
    [Scenario],
    ([scenario]) => run(scenario),
    { arbitrary: { runs: 200, size: 24, seed: "stale-coverage-oracle-v1" }, timeout: 120_000 }
);

it.effect("a read during a held refresh of a stale collection is served within the bound", () =>
    Effect.gen(function* () {
        const agreed = yield* run({
            stale: true,
            poll: false,
            operations: [
                { kind: "read", subset: "whole" },
                { kind: "advance", ms: 1_200 },
                { kind: "edit", id: "i0", value: 5, group: "a" },
                { kind: "hold", what: "loads" },
                { kind: "pass" },
                { kind: "read", subset: "point" },
                { kind: "read", subset: "groupA" },
                { kind: "advance", ms: 3_000 },
                { kind: "read", subset: "whole" },
                { kind: "release" },
            ],
        });
        expect(agreed).toBe(true);
    })
);
