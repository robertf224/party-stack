import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { o, validate } from "../ir/index.js";
import { contextPartition } from "../utils/context.js";
import { certain, uncertain } from "../utils/uncertain.js";
import { compareValues, equalValues, evaluateOperator } from "./operators.js";
import {
    caseExpression,
    contains,
    context,
    eq,
    field,
    literal,
    selectCase,
    selectField,
    sub,
    validateQueryDocument,
} from "./index.js";
import type { OntologyIR, QueryDocument } from "../ir/generated/types.js";

const string = o.string({});
const property = (name: string, type: import("../ir/generated/types.js").TypeDef = string) => ({
    name,
    displayName: name,
    type,
});
const definition = (): OntologyIR => ({
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    context: { type: o.struct({ fields: [property("user"), property("tenant")] }) },
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [
                property("id"),
                property("title"),
                property("admins", o.list({ elementType: string })),
            ],
        },
    ],
    actionTypes: [{ name: "save", displayName: "Save", parameters: [property("title")], logic: [] }],
});
const document = (): QueryDocument => ({
    select: [
        sub("projects", {
            from: { source: { objectType: "Project" }, binding: "p" },
            where: contains(field("p", "admins"), context("user")),
            select: [selectField("id", field("p", "id")), selectField("title", field("p", "title"))],
        }),
    ],
});

describe("query semantic validation", () => {
    it("accepts source-preserving entity grants and an ordinary string user context", () => {
        const ir = definition();
        ir.policy = { read: document(), actions: [{ actionType: "save", check: literal(true) }] };
        expect(validate(ir)).toEqual({ kind: "ok", value: undefined });
        expect(validateQueryDocument(ir, document(), { mode: "entity" })).toEqual([]);
    });
    it("rejects unknown bindings, unknown properties, incompatible conditions and renamed grants", () => {
        const ir = definition();
        for (const expression of [field("missing", "id"), field("p", "missing")]) {
            const d = document();
            if (d.select[0]?.kind === "sub") d.select[0].value.query.where = eq(expression, literal("x"));
            expect(validateQueryDocument(ir, d).length).toBeGreaterThan(0);
        }
        const d = document();
        if (d.select[0]?.kind === "sub")
            d.select[0].value.query.select = [selectField("title", field("p", "admins"))];
        expect(validateQueryDocument(ir, d, { mode: "entity" })).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ message: expect.stringContaining("preserve") }),
            ])
        );
        expect(
            validateQueryDocument(ir, {
                select: [selectCase({ branches: [{ condition: literal("yes"), select: [] }] })],
            }).length
        ).toBeGreaterThan(0);
    });
    it("checks CASE branch types and nested query window invariants", () => {
        const d = document();
        if (d.select[0]?.kind === "sub")
            d.select[0].value.query.page = { limit: -1, offset: 0, after: { values: [1], key: "id" } };
        expect(validateQueryDocument(definition(), d).length).toBeGreaterThanOrEqual(3);
        expect(
            validateQueryDocument(definition(), {
                select: [
                    selectField(
                        "label",
                        caseExpression({
                            branches: [{ condition: literal(true), result: literal("x") }],
                            else: literal(1),
                        })
                    ),
                ],
            }).length
        ).toBeGreaterThan(0);
    });
    it("checks policy action targets and bound parameter names", () => {
        const ir = definition();
        ir.policy = { read: document(), actions: [{ actionType: "missing", check: literal(true) }] };
        expect(validate(ir).kind).toBe("err");
        ir.policy.actions = [
            {
                actionType: "save",
                check: literal(true),
                bind: [{ parameter: "missing", expression: literal("x") }],
            },
        ];
        expect(validate(ir).kind).toBe("err");
    });
});

describe("partial knowledge and partition identity", () => {
    it("compares Temporal values symmetrically and orders extended/negative date years numerically", () => {
        const instant = Temporal.Instant.from("2026-10-28T00:00:00Z");
        expect(equalValues({}, instant)).toBe(false);
        expect(equalValues(instant, {})).toBe(false);
        expect(equalValues(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
        expect(
            compareValues(Temporal.PlainDate.from("-000001-01-01"), Temporal.PlainDate.from("-000002-01-01"))
        ).toBeGreaterThan(0);
        expect(
            compareValues(Temporal.PlainDate.from("+010000-01-01"), Temporal.PlainDate.from("9999-01-01"))
        ).toBeGreaterThan(0);
    });
    it("distinguishes known nullish values from uncertainty and lifts boolean logic", () => {
        const u = uncertain();
        expect(evaluateOperator("and", [certain(false), u])).toEqual(certain(false));
        expect(evaluateOperator("and", [certain(true), u])).toEqual(u);
        expect(evaluateOperator("or", [certain(true), u])).toEqual(certain(true));
        expect(evaluateOperator("not", [u])).toEqual(u);
        expect(evaluateOperator("eq", [certain(undefined), certain(undefined)])).toEqual(certain(true));
        expect(evaluateOperator("eq", [certain(undefined), certain(null)])).toEqual(certain(false));
        expect(() => evaluateOperator("add", [certain("1"), certain(2)])).toThrow(/numbers/);
    });
    it("preserves account defaults and isolates configured composite partitions", () => {
        const ir = definition();
        expect(contextPartition(ir, { user: "a" })).toBe("a");
        ir.context!.partition = [["user"], ["tenant"]];
        const a = contextPartition(ir, { user: "a", tenant: "x" });
        expect(a).not.toBe(contextPartition(ir, { user: "a", tenant: "y" }));
        expect(a).not.toBe(contextPartition(ir, { user: "x", tenant: "a" }));
        expect(() => contextPartition(ir, { user: "a" })).toThrow(/unavailable/);
    });
});
