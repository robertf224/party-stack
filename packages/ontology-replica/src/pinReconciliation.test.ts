import { expect, it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope } from "effect";
import { makeReplicaKernel } from "./engine.js";
import { makeQueryPin } from "./pins.js";
import type { OntologyIR, QueryDocument } from "@party-stack/ontology-spec";

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
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
};
const document = (id?: string): QueryDocument => ({
    select: [
        q.sub("items", {
            from: { source: { objectType: "Item" }, binding: "item" },
            ...(id === undefined ? {} : { where: q.eq(q.field("item", "id"), q.literal(id)) }),
            select: [q.selectField("id", q.field("item", "id"))],
        }),
    ],
});
const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    const data = [{ id: "a" }, { id: "b" }];
    const backend = makeOntologyBackend({
        name: "pin-reconciliation",
        sourceId: "pin-reconciliation",
        ir,
        supportsIdempotency: false,
        applyAction: () => Effect.die("No actions in this fixture"),
        queryFunction: () => Effect.void,
        loadSubset: (request) =>
            compileObjectSubset(ir, request).pipe(
                Effect.map((subset) => ({
                    complete: true,
                    rows: evaluateQuery(
                        data.map((value) => ({ key: value.id, value })),
                        subset.query
                    ),
                }))
            ),
    });
    const kernel = yield* makeReplicaKernel({
        tables,
        namespace: "pin-reconciliation",
        ir,
        backend,
        execute: () => Effect.void,
        startSync: false,
        objectCacheGc: false,
    });
    const counts = { graphReads: 0, demands: 0, active: 0 };
    const engine: typeof kernel = {
        ...kernel,
        snapshotSubset: (...args) =>
            Effect.sync(() => counts.graphReads++).pipe(Effect.andThen(kernel.snapshotSubset(...args))),
        demand: (subset) =>
            Effect.gen(function* () {
                yield* kernel.demand(subset);
                counts.demands++;
                counts.active++;
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        counts.active--;
                    })
                );
            }),
    };
    const options = { engine, tables, namespace: "pin-reconciliation", ir };
    return { tables, data, engine, counts, options };
});

it.effect(
    "visible notifications queued during initial pin acquisition do not repeat its graph evaluation",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const pin = yield* makeQueryPin({ ...f.options, live: true });
                // Loading this first graph emits visibleChanges while refresh is active.
                yield* pin.setPin(document());
                yield* pin.refresh;
                yield* pin.refresh;
                expect(yield* pin.pinStatus).toMatchObject({ ready: true });
                expect(f.counts.graphReads).toBe(1);
                expect(f.counts.demands).toBe(1);
                expect(f.counts.active).toBe(1);
            })
        )
);

it.effect(
    "unchanged coverage can be skipped, but coverage invalidation and actual row changes reconcile",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const pin = yield* makeQueryPin({ ...f.options, live: false });
                yield* pin.setPin(document());
                const revision = yield* f.tables.read(f.engine.visibleRevision);
                yield* pin.refresh;
                expect(f.counts.graphReads).toBe(1);
                yield* f.engine.invalidate(["Item"]);
                expect(yield* f.tables.read(f.engine.visibleRevision)).toBe(revision);
                yield* pin.refresh;
                expect(f.counts.graphReads).toBe(2);
                expect(yield* f.tables.read(f.engine.visibleRevision)).toBe(revision);
                f.data.push({ id: "new" });
                yield* f.engine.invalidate(["Item"]);
                yield* pin.refresh;
                expect(f.counts.graphReads).toBe(3);
                expect(yield* f.tables.read(f.engine.visibleRevision)).toBeGreaterThan(revision);
                expect(yield* f.engine.get("Item", "new")).toEqual({ id: "new" });
                yield* pin.refresh;
                expect(f.counts.graphReads).toBe(3);
            })
        )
);

it.effect("a saved error retries even when pin generation, row revision and coverage are unchanged", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const pin = yield* makeQueryPin({ ...f.options, live: false });
            yield* pin.setPin(document());
            const state = Table.make<Record<string, unknown>>({
                name: JSON.stringify(["replica", "pin-reconciliation", "query-pin"]),
            });
            const head = (yield* f.tables.get(state, "head"))!;
            yield* f.tables.put(state, "head", {
                ...head,
                error: { kind: "Unavailable", message: "Temporary failure" },
            });
            yield* pin.refresh;
            expect(f.counts.graphReads).toBe(2);
            expect(yield* pin.pinStatus).toMatchObject({ ready: true, error: undefined });
        })
    )
);

it.effect("a visible local edit reconciles even while the existing coverage remains complete", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const pin = yield* makeQueryPin({ ...f.options, live: false });
            yield* pin.setPin(document());
            const base = Table.make<{ id: string }>({
                name: JSON.stringify(["replica", "pin-reconciliation", "base:Item"]),
            });
            yield* f.engine.localTransaction((tx) => tx.put(base, "new", { id: "new" }));
            expect(
                yield* f.tables.read((tx) => f.engine.hasCoverage(tx, { objectType: "Item", query: {} }))
            ).toBe(true);
            yield* pin.refresh;
            expect(f.counts.graphReads).toBe(2);
            const rows = Table.make<{ objectType: string; key: string }>({
                name: JSON.stringify(["replica", "pin-reconciliation", "pins"]),
            });
            expect((yield* f.tables.query(rows)).some((row) => row.value.key === "new")).toBe(true);
            yield* pin.refresh;
            expect(f.counts.graphReads).toBe(2);
        })
    )
);

it.effect("new intent, clear and reopening a pin owner all acquire fresh scoped demand", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const firstScope = yield* Scope.make();
            const first = yield* Scope.provide(makeQueryPin({ ...f.options, live: false }), firstScope);
            yield* first.setPin(document("a"));
            yield* first.setPin(document("a"));
            expect(f.counts.graphReads).toBe(2);
            yield* first.clearPin();
            expect(yield* first.pinStatus).toBeUndefined();
            expect(f.counts.active).toBe(0);
            yield* first.setPin(document("b"));
            expect(f.counts.graphReads).toBe(3);
            yield* Scope.close(firstScope, Exit.void);
            expect(f.counts.active).toBe(0);
            const reopened = yield* makeQueryPin({ ...f.options, live: false });
            yield* reopened.refresh;
            expect(yield* reopened.pinStatus).toMatchObject({ ready: true });
            expect(f.counts.graphReads).toBe(4);
            expect(f.counts.active).toBe(1);
            yield* reopened.refresh;
            expect(f.counts.graphReads).toBe(4);
        })
    )
);
