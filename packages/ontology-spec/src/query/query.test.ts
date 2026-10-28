import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { compileEffectSchemas } from "../codecs/compiler.js";
import { o } from "../ir/generated/builders.js";
import irSchema from "../ir/schema.js";
import { validate } from "../ir/validate.js";
import {
    and,
    caseExpression,
    context,
    eq,
    exists,
    field,
    ilike,
    input,
    literal,
    not,
    selectCase,
    selectField,
    sub,
} from "./index.js";
import type { Query, QueryDocument, Subset } from "./index.js";

const codecs = compileEffectSchemas(irSchema);
const codec = codecs.namedSchemas.QueryDocument!;
const json = Schema.fromJsonString(Schema.toCodecJson(codec));
const decode = Schema.decodeUnknownSync(codec, { onExcessProperty: "error" });

const approvals = (): Query => ({
    from: { source: { objectType: "PostApproval" }, binding: "approval" },
    where: eq(field("approval", "id"), context("approvalId")),
    select: [
        selectField("id", field("approval", "id")),
        sub(
            "person",
            {
                from: { source: { objectType: "Person" }, binding: "person" },
                where: eq(field("person", "id"), field("approval", "personId")),
                select: [
                    selectField("id", field("person", "id")),
                    selectField("name", field("person", "name")),
                    selectCase({
                        branches: [
                            {
                                condition: context("permissions", "pii"),
                                select: [selectField("ssn", field("person", "ssn"))],
                            },
                        ],
                    }),
                ],
            },
            "one"
        ),
    ],
});

describe("portable Query IR grammar", () => {
    it("round-trips multiple roots, ancestor correlations and shared subset windows", () => {
        const subset: Subset = {
            where: and(
                ilike(field("post", "name"), input("search")),
                not(eq(field("post", "id"), literal("hidden")))
            ),
            orderBy: [{ expression: field("post", "name"), direction: "asc" }],
            page: { limit: 20, after: { values: ["Paris"], key: "post-20" } },
        };
        const document: QueryDocument = {
            inputs: [{ name: "search", displayName: "Search", type: o.string({}) }],
            select: [
                sub("approval", approvals(), "one"),
                sub("locations", {
                    from: { source: { ontology: "reference", objectType: "Post" }, binding: "post" },
                    ...subset,
                    select: [
                        selectField("id", field("post", "id")),
                        selectField("name", field("post", "name")),
                    ],
                }),
            ],
        };
        const encoded = Schema.encodeSync(json)(document);
        expect(Schema.decodeUnknownSync(json)(encoded)).toEqual(document);
        const wireQuery = JSON.parse(encoded).select[1].value.query;
        expect(wireQuery).toMatchObject(subset);
        expect(wireQuery).not.toHaveProperty("subset");
        expect(Schema.decodeUnknownSync(codecs.namedSchemas.Subset!)(subset)).toEqual(subset);
    });

    it("round-trips multi-branch CASE and recursively nested selection cases with alternate subqueries", () => {
        const query = approvals();
        const document: QueryDocument = {
            select: [
                selectField("eligible", exists(query)),
                selectField(
                    "label",
                    caseExpression({
                        branches: [
                            { condition: literal(false), result: literal("first") },
                            { condition: literal(true), result: literal("second") },
                        ],
                        else: literal("fallback"),
                    })
                ),
                selectCase({
                    branches: [
                        {
                            condition: context("isAdmin"),
                            select: [
                                sub("approval", query, "one"),
                                selectCase({
                                    branches: [
                                        {
                                            condition: context("canReadPII"),
                                            select: [selectField("ssn", field("person", "ssn"))],
                                        },
                                    ],
                                    else: [selectField("notice", literal("Restricted"))],
                                }),
                            ],
                        },
                        { condition: context("isSelf"), select: [sub("approval", query, "one")] },
                    ],
                    else: [sub("publicApprovals", query)],
                }),
                sub("oneApproval", query, "one"),
                sub("approvalList", { ...query, page: { limit: 1 } }),
            ],
        };
        expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(document))).toEqual(document);
        expect(document.select[1]?.kind).toBe("field");
        expect(document.select[2]?.kind).toBe("selectCase");
        expect(document.select[3]).not.toEqual(document.select[4]);
    });

    it("uses operator-specific payloads and rejects missing binary operands", () => {
        expect(decode({ select: [selectField("same", eq(literal(1), literal(1)))] })).toMatchObject({
            select: [
                {
                    value: {
                        expression: {
                            kind: "eq",
                            value: { left: { kind: "literal" }, right: { kind: "literal" } },
                        },
                    },
                },
            ],
        });
        expect(() =>
            decode({
                select: [
                    {
                        kind: "field",
                        value: { name: "bad", expression: { kind: "eq", value: { left: literal(1) } } },
                    },
                ],
            })
        ).toThrow(/right/);
        expect(() =>
            decode({
                select: [
                    {
                        kind: "field",
                        value: {
                            name: "bad",
                            expression: { kind: "not", value: { expressions: [literal(true)] } },
                        },
                    },
                ],
            })
        ).toThrow(/expression/);
    });

    it("rejects generic operations, flat joins and malformed subquery cardinality", () => {
        expect(() =>
            decode({
                select: [
                    {
                        kind: "field",
                        value: {
                            name: "bad",
                            expression: { kind: "operation", value: { operator: "raw-sql", arguments: [] } },
                        },
                    },
                ],
            })
        ).toThrow(/expression/);
        expect(() =>
            decode({
                select: [{ kind: "sub", value: { name: "bad", query: approvals(), cardinality: "maybe" } }],
            })
        ).toThrow(/cardinality/);
        expect(() =>
            decode({ select: [sub("missingSource", { ...approvals(), from: undefined } as never)] })
        ).toThrow(/from/);
        expect(() => decode({ select: [sub("flat", { ...approvals(), joins: [] } as never)] })).toThrow(
            /joins/
        );
        expect(() => decode({ select: [sub("wrapped", { ...approvals(), subset: {} } as never)] })).toThrow(
            /subset/
        );
    });

    it("keeps scalar CASE results and selection CASE groups structurally distinct", () => {
        expect(() =>
            decode({
                select: [
                    selectField("bad", {
                        kind: "case",
                        value: { branches: [{ condition: literal(true), select: [] }], else: literal(false) },
                    } as never),
                ],
            })
        ).toThrow(/branches/);
        expect(() =>
            decode({
                select: [
                    {
                        kind: "selectCase",
                        value: { branches: [{ condition: literal(true), result: literal("bad") }] },
                    },
                ],
            })
        ).toThrow(/select/);
    });

    it("does not silently enable query expressions in existing action defaults", () => {
        const definition = {
            types: [],
            objectTypes: [],
            linkTypes: [],
            queryFunctionTypes: [],
            actionTypes: [
                {
                    name: "create",
                    displayName: "Create",
                    logic: [],
                    parameters: [
                        {
                            name: "test",
                            displayName: "Test",
                            type: o.boolean({}),
                            defaultValue: exists(approvals()),
                        },
                    ],
                },
            ],
        };
        expect(validate(definition)).toMatchObject({
            kind: "err",
            value: expect.arrayContaining([
                expect.objectContaining({
                    message: "Query expressions are not supported in action defaults yet.",
                }),
            ]),
        });
    });
});
