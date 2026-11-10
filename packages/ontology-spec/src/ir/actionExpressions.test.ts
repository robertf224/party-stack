import { expect, test } from "vitest";
import * as q from "../query/index.js";
import { o } from "./generated/builders.js";
import { validate } from "./validate.js";
import type { Expression, OntologyIR, TypeDef } from "./generated/types.js";

const parameter = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const inputs = [parameter("amount", o.integer({})), parameter("label", o.string({}))];
const definition = (expression: Expression, type: TypeDef = o.unknown({})): OntologyIR => ({
    types: [],
    objectTypes: [],
    linkTypes: [],
    queryFunctionTypes: [],
    actionTypes: [
        {
            name: "save",
            displayName: "Save",
            logic: [],
            parameters: [...inputs, { ...parameter("result", type), defaultValue: expression }],
        },
    ],
});

test("action defaults share scalar typing, including numeric result constraints and CASE", () => {
    const expression = q.caseExpression({
        branches: [
            {
                condition: q.and(
                    q.gt(q.input("amount"), q.literal(0)),
                    q.ilike(q.input("label"), q.literal("a%"))
                ),
                result: q.add(q.input("amount"), q.literal(2)),
            },
        ],
        else: q.literal(0),
    });
    expect(validate(definition(expression, o.integer({})))).toEqual({ kind: "ok", value: undefined });
    expect(validate(definition(q.eq(q.input("amount"), q.literal(0)), o.string({})))).toMatchObject({
        kind: "err",
        value: expect.arrayContaining([
            expect.objectContaining({ message: expect.stringContaining("incompatible type") }),
        ]),
    });
});

test.each([
    [q.add(q.input("label"), q.literal(1)), "Arithmetic requires numeric operands."],
    [q.and(q.input("label")), "Expected a boolean expression."],
    [q.contains(q.input("amount"), q.literal(1)), "Membership requires a list operand."],
    [q.ilike(q.input("amount"), q.literal("%")), "Expected a string expression."],
    [q.gt(q.literal([1]), q.literal([2])), "Ordered comparisons require compatible scalar operands."],
    [
        q.caseExpression({
            branches: [{ condition: q.literal(true), result: q.literal(1) }],
            else: q.literal("x"),
        }),
        "CASE results have incompatible types.",
    ],
] as const)("actions and queries reject the same invalid scalar expression %#", (expression, message) => {
    const ir = definition(expression);
    const result = validate(ir);
    expect(result).toMatchObject({
        kind: "err",
        value: expect.arrayContaining([expect.objectContaining({ message })]),
    });
    expect(q.validateQueryDocument(ir, { inputs, select: [q.selectField("result", expression)] })).toEqual(
        expect.arrayContaining([expect.objectContaining({ message })])
    );
});

test("queries and action defaults accept ordered booleans without accepting mixed scalar families", () => {
    for (const op of [q.lt, q.lte, q.gt, q.gte]) {
        const expression = op(q.literal(false), q.literal(true));
        const ir = definition(expression, o.boolean({}));
        expect(validate(ir)).toEqual({ kind: "ok", value: undefined });
        expect(q.validateQueryDocument(ir, { select: [q.selectField("result", expression)] })).toEqual([]);
        expect(
            q.validateQueryDocument(ir, {
                select: [q.selectField("result", op(q.literal(false), q.literal(1)))],
            }).length
        ).toBeGreaterThan(0);
    }
});

test("action clocks and UUIDs remain unavailable to query plans", () => {
    for (const [expression, type] of [
        [o.Expression.uuid({}), o.string({})],
        [o.Expression.now({}), o.timestamp({})],
    ] as const) {
        const ir = definition(expression, type);
        expect(validate(ir).kind).toBe("ok");
        expect(q.validateQueryDocument(ir, { select: [q.selectField("result", expression)] })).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining("Clock and random") }),
            ])
        );
    }
});
