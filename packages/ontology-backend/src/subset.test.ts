import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import fc from "fast-check";
import { expect, test } from "vitest";
import { executeQuery } from "./query.js";
import { compileObjectSubset, objectSubset } from "./subset.js";
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
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.optional({ type: o.integer({}) }) },
            ],
        },
    ],
};
test("logical subset lowering agrees with finite reference evaluation for optional values, boolean predicates and windows", async () => {
    await fc.assert(
        fc.asyncProperty(
            fc.array(fc.option(fc.integer({ min: -5, max: 5 }), { nil: undefined }), { maxLength: 18 }),
            fc.integer({ min: -5, max: 5 }),
            fc.constantFrom("eq", "ne", "lt", "lte", "gt", "gte" as const),
            fc.boolean(),
            fc.option(fc.boolean(), { nil: undefined }),
            fc.integer({ min: 0, max: 8 }),
            fc.integer({ min: 0, max: 5 }),
            async (values, value, operator, negate, constant, limit, offset) => {
                const rows = values.map((count, i) => ({ key: String(i), value: { id: String(i), count } }));
                const comparison = q[operator](q.field("item", "count"), q.literal(value));
                const predicate = constant === undefined ? comparison : q.or(comparison, q.literal(constant));
                const subset = {
                    from: { source: { objectType: "Item" }, binding: "item" },
                    where: negate ? q.not(predicate) : predicate,
                    orderBy: [{ expression: q.field("item", "count") }],
                    page: { limit, offset },
                };
                await Effect.runPromise(
                    Effect.gen(function* () {
                        const compiled = yield* compileObjectSubset(ir, subset);
                        const reference = yield* executeQuery(
                            {
                                select: [
                                    q.sub("items", {
                                        ...subset,
                                        select: [q.selectField("id", q.field("item", "id"))],
                                    }),
                                ],
                            },
                            {
                                reader: {
                                    ir,
                                    loadSubset: (_type, scan) => Effect.succeed(evaluateQuery(rows, scan)),
                                },
                                strategy: "reference",
                            }
                        );
                        expect(evaluateQuery(rows, compiled.query).map((r) => r.key)).toEqual(
                            (reference.value.items as { id: string }[]).map((r) => r.id)
                        );
                        const roundtrip = yield* compileObjectSubset(
                            ir,
                            objectSubset("Item", compiled.query)
                        );
                        expect(evaluateQuery(rows, roundtrip.query).map((r) => r.key)).toEqual(
                            evaluateQuery(rows, compiled.query).map((r) => r.key)
                        );
                    })
                );
            }
        ),
        { numRuns: 70 }
    );
});
