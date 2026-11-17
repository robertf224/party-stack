import { it } from "@effect/vitest";
import { makeOntologyBackend } from "@party-stack/ontology-backend";
import { compileObjectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { eq, evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope, Stream } from "effect";
import { expect } from "vitest";
import { makeReplica } from "./testing.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

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
                { name: "value", displayName: "Value", type: o.integer({}) },
            ],
        },
    ],
};
const namespace = "legacy-filters";
const table = (part: string) =>
    Table.make<Record<string, unknown>>({ name: JSON.stringify(["replica", namespace, part]) });
const coverage = table("coverage");
const actionQueries = table("action-queries");
// The `{ op, left, right }` storage predicate format persisted before storage filters
// became spec expressions.
const legacySubset = {
    objectType: "Item",
    query: { where: { op: "eq", left: { _tag: "Field", path: ["id"] }, right: "two" } },
};

it.effect("opening a replica drops persisted filters in the old predicate format and refetches them", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const loads: unknown[] = [];
            const rows = [
                { key: "one", value: { id: "one", value: 1 } },
                { key: "two", value: { id: "two", value: 2 } },
            ];
            const backend = makeOntologyBackend({
                ir,
                name: namespace,
                sourceId: namespace,
                supportsIdempotency: false,
                applyAction: () => Effect.die("Unexpected action"),
                queryFunction: () => Effect.void,
                watchSubset: () => Effect.succeed(Stream.never),
                loadSubset: (request) =>
                    Effect.gen(function* () {
                        const subset = yield* compileObjectSubset(ir, request);
                        loads.push(subset.query?.where);
                        return { rows: evaluateQuery(rows, subset.query), complete: true };
                    }),
            });
            const open = () =>
                makeReplica({
                    ir,
                    tables,
                    backend,
                    namespace,
                    startSync: false,
                    objectCacheGc: false,
                    execute: () => Effect.void,
                });
            // A current-format coverage record from an earlier session.
            const one = { objectType: "Item", query: { where: eq(field("id"), "one") } };
            const seedScope = yield* Scope.make();
            const seed = yield* open().pipe(Scope.provide(seedScope));
            yield* seed.demand(one).pipe(Scope.provide(seedScope));
            yield* seed.syncSubset(one);
            yield* Scope.close(seedScope, Exit.void);
            const kept = (yield* tables.query(coverage)).map((row) => row.key);
            expect(kept.length).toBeGreaterThan(0);

            // Records an older version wrote in the old format.
            yield* tables.put(coverage, "legacy", { subset: legacySubset, complete: true, updatedAt: 0 });
            yield* tables.put(actionQueries, JSON.stringify(["old-action", "legacy"]), {
                action: "old-action",
                subset: legacySubset,
            });

            const replica = yield* open();
            const remaining = (yield* tables.query(coverage)).map((row) => row.key);
            expect(remaining).not.toContain("legacy");
            expect(remaining).toEqual(expect.arrayContaining(kept));
            expect(yield* tables.query(actionQueries)).toEqual([]);

            // The same subset, demanded in the current format, reloads from the backend.
            const two = { objectType: "Item", query: { where: eq(field("id"), "two") } };
            const before = loads.length;
            yield* replica.demand(two);
            yield* replica.syncSubset(two);
            expect(loads.length).toBeGreaterThan(before);
            expect(loads.at(-1)).toEqual(eq(field("id"), "two"));
            expect(yield* replica.get("Item", "two")).toMatchObject({ id: "two", value: 2 });
        })
    )
);
