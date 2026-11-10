import { assert, it } from "@effect/vitest";
import { Arbitrary, Effect, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import { keyCode, scalarKey, validateQuery } from "./evaluate.js";
import { isField, validateQueryShape } from "./schema.js";
import type { Operand, Predicate, Query } from "../model.js";

// Original validator: encoding is an independent acceptance/error oracle for
// the validation-only primitive fast path, including traversal/error order.
function encodedValidator(query: Query): void {
    validateQueryShape(query);
    const operand = (value: Operand) => {
        if (!isField(value)) scalarKey(value);
    };
    const predicate = (value: Predicate): void => {
        if (value.op === "and" || value.op === "or") {
            for (const child of value.predicates) predicate(child);
        } else if (value.op === "not") predicate(value.predicate);
        else {
            operand(value.left);
            if (value.op === "in") for (const member of value.values) scalarKey(member);
            else operand(value.right);
        }
    };
    if (query.where) predicate(query.where);
    if (query.after) {
        keyCode(query.after.key);
        for (const value of query.after.values) scalarKey(value);
    }
    for (const value of [query.offset, query.limit]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new Error("Limit and offset must be nonnegative safe integers.");
    }
    if (query.after && query.after.values.length !== (query.orderBy?.length ?? 0))
        throw new Error("Cursor must include one value for every ordering field.");
}
function outcome(run: () => void) {
    try {
        run();
        return { accepted: true };
    } catch (error) {
        return { accepted: false, error };
    }
}
function comparable(run: () => void) {
    const result = outcome(run);
    if (result.accepted) return { accepted: true };
    const error = result.error;
    return error instanceof Error
        ? { accepted: false, constructor: error.constructor, message: error.message }
        : { accepted: false, error };
}
const field = { _tag: "Field", path: ["value"] } as const;
function positions(value: unknown): unknown[] {
    return [
        { where: { op: "eq", left: field, right: value } },
        { where: { op: "lt", left: value, right: field } },
        { where: { op: "in", left: field, values: ["valid", value] } },
        { where: { op: "in", left: value, values: [] } },
        { where: { op: "contains", left: field, right: value } },
        { where: { op: "like", left: value, right: "%" } },
        {
            where: {
                op: "and",
                predicates: [
                    { op: "eq", left: field, right: "valid" },
                    {
                        op: "not",
                        predicate: { op: "or", predicates: [{ op: "gte", left: value, right: field }] },
                    },
                ],
            },
        },
        { orderBy: [{ field }], after: { key: "row", values: [value] } },
        { after: { key: value, values: [] } },
    ];
}
function assertOracle(query: unknown) {
    assert.deepStrictEqual(
        comparable(() => validateQuery(query as Query)),
        comparable(() => encodedValidator(query as Query))
    );
}

test("all literal, IN, nested-predicate and cursor positions match physical scalar validation", () => {
    const values: unknown[] = [
        undefined,
        null,
        false,
        true,
        -0,
        Number.MIN_VALUE,
        Number.MAX_VALUE,
        "",
        "\0",
        "a\0",
        "\ud800",
        "😀",
        "\uffff",
        "x".repeat(1000),
        0n,
        -1n,
        10n ** 1000n,
        new Date(-8_640_000_000_000_000),
        new Date(8_640_000_000_000_000),
        Temporal.Instant.from("-100000-01-01T00:00:00Z"),
        Temporal.PlainDate.from("2026-11-09"),
        { [Symbol.toStringTag]: "Temporal.Instant", toString: () => "2026-11-09T00:00:00Z" },
        { [Symbol.toStringTag]: "Temporal.PlainDate", toString: () => "2026-11-09" },
        NaN,
        Infinity,
        -Infinity,
        new Date(NaN),
        {},
        [],
        Symbol("invalid"),
        () => 0,
        { [Symbol.toStringTag]: "Temporal.Instant", toString: () => "invalid" },
        { [Symbol.toStringTag]: "Temporal.PlainDate", toString: () => "invalid" },
        new String("boxed"),
        new Number(1),
        new Boolean(false),
        field,
    ];
    for (const value of values) for (const query of positions(value)) assertOracle(query);
});

test("window errors, malformed shapes and invalid cursor key restrictions retain exact errors", () => {
    const queries: unknown[] = [
        { limit: -1 },
        { offset: 0.5 },
        { limit: NaN },
        { limit: Infinity },
        { limit: Number.MAX_SAFE_INTEGER + 1 },
        { offset: "1" },
        { orderBy: [{ field }], after: { key: "row", values: [] } },
        { after: { key: "row", values: [1] } },
        { after: { key: true, values: [] } },
        { after: { key: 1n, values: [] } },
        { after: { key: NaN, values: [] } },
        { after: { key: Infinity, values: [] } },
        { orderBy: [{ field, direction: "invalid" }] },
        { where: { op: "invalid", left: field, right: "value" } },
        { where: { op: "in", left: field, values: [NaN] }, limit: -1 },
    ];
    for (const query of queries) {
        assertOracle(query);
        expect(comparable(() => validateQuery(query as Query)).accepted).toBe(false);
    }
});

test("rich-value validation still propagates the original codec exception", () => {
    const failure = new Error("tag getter failed");
    const value = {
        get [Symbol.toStringTag]() {
            throw failure;
        },
    };
    const query = { where: { op: "eq", left: field, right: value } } as unknown as Query;
    expect(outcome(() => validateQuery(query)).error).toBe(failure);
    expect(outcome(() => encodedValidator(query)).error).toBe(failure);
});

const seed = Schema.Struct({
    kind: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 18 })),
    text: Schema.String,
    number: Schema.Finite,
});
function valueOf(input: Schema.Schema.Type<typeof seed>): unknown {
    switch (input.kind) {
        case 0:
            return undefined;
        case 1:
            return null;
        case 2:
            return input.number >= 0;
        case 3:
            return input.text;
        case 4:
            return input.number;
        case 5:
            return BigInt(Math.trunc(input.number));
        case 6:
            return new Date(input.number);
        case 7:
            return Temporal.Instant.from("2026-11-09T00:00:00Z");
        case 8:
            return Temporal.PlainDate.from("2026-11-09");
        case 9:
            return NaN;
        case 10:
            return Infinity;
        case 11:
            return -Infinity;
        case 12:
            return new Date(NaN);
        case 13:
            return {};
        case 14:
            return Symbol(input.text);
        case 15:
            return () => input.number;
        case 16:
            return { [Symbol.toStringTag]: "Temporal.Instant", toString: () => input.text };
        case 17:
            return { _tag: "Field", path: [input.text] };
        default:
            return [input.number];
    }
}
it.effect.prop(
    "generated scalar families and nested query paths match the encoding oracle",
    [Arbitrary.schema(Schema.Array(seed).check(Schema.isMaxLength(8)))],
    ([inputs]) =>
        Effect.try(() => {
            const values = inputs.map(valueOf);
            for (const value of values) for (const query of positions(value)) assertOracle(query);
            for (const op of ["and", "or"] as const)
                assertOracle({
                    where: {
                        op,
                        predicates: values.map((value, index) =>
                            index % 2
                                ? { op: "not", predicate: { op: "eq", left: field, right: value } }
                                : { op: "in", left: value, values: [...values].reverse() }
                        ),
                    },
                    orderBy: values.map(() => ({ field })),
                    after: { key: inputs[0]?.text ?? "", values },
                });
        }),
    { arbitrary: { runs: 500, size: 16, seed: "query-scalar-validity-v1" } }
);
