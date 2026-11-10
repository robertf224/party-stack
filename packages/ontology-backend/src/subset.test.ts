import { it } from "@effect/vitest";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect, Schema } from "effect";
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
it.live.prop(
    "logical subset lowering agrees with finite reference evaluation for optional values, boolean predicates and windows",
    [
        Schema.Array(
            Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5 })))
        ).check(Schema.isMaxLength(18)),
        Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5 })),
        Schema.Literals(["eq", "ne", "lt", "lte", "gt", "gte"]),
        Schema.Boolean,
        Schema.UndefinedOr(Schema.Boolean),
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
    ],
    ([values, value, operator, negate, constant, limit, offset]) =>
        Effect.gen(function* () {
            const rows = values.map((count, i) => ({ key: String(i), value: { id: String(i), count } }));
            const comparison = q[operator](q.field("item", "count"), q.literal(value));
            const predicate = constant === undefined ? comparison : q.or(comparison, q.literal(constant));
            const subset = {
                from: { source: { objectType: "Item" }, binding: "item" },
                where: negate ? q.not(predicate) : predicate,
                orderBy: [{ expression: q.field("item", "count") }],
                page: { limit, offset },
            };
            yield* Effect.gen(function* () {
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
                const roundtrip = yield* compileObjectSubset(ir, objectSubset("Item", compiled.query));
                expect(evaluateQuery(rows, roundtrip.query).map((r) => r.key)).toEqual(
                    evaluateQuery(rows, compiled.query).map((r) => r.key)
                );
            });
        }),
    { arbitrary: { runs: 70 } }
);
