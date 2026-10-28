import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { compileEffectSchemas } from "../codecs/compiler.js";
import { o } from "../ir/generated/builders.js";
import irSchema from "../ir/schema.js";
import { validate } from "../ir/validate.js";
import { context, field, input, literal, nested, operation, some, value, when } from "./index.js";
import type { Query, QueryDocument } from "./index.js";

const codecs = compileEffectSchemas(irSchema);
const codec = codecs.namedSchemas.QueryDocument!;
const json = Schema.fromJsonString(Schema.toCodecJson(codec));

const approvals = (): Query => ({
    from: { source: { objectType: "PostApproval" }, binding: "approval" },
    where: operation("eq", field("approval", "id"), context("approvalId")),
    select: [
        value("id", field("approval", "id")),
        nested(
            "person",
            {
                from: { source: { objectType: "Person" }, binding: "person" },
                where: operation("eq", field("person", "id"), field("approval", "personId")),
                select: [
                    value("id", field("person", "id")),
                    value("name", field("person", "name")),
                    when(context("permissions", "pii"), [value("ssn", field("person", "ssn"))]),
                ],
            },
            "one"
        ),
    ],
});

describe("portable Query IR grammar", () => {
    it("round-trips multiple roots, ancestor correlations, guarded fields and per-parent windows", () => {
        const document: QueryDocument = {
            inputs: [{ name: "search", displayName: "Search", type: o.string({}) }],
            select: [
                nested("approval", approvals(), "one"),
                nested("locations", {
                    from: { source: { ontology: "reference", objectType: "Post" }, binding: "post" },
                    where: operation("ilike", field("post", "name"), input("search")),
                    select: [value("id", field("post", "id")), value("name", field("post", "name"))],
                    orderBy: [{ expression: field("post", "name"), direction: "asc" }],
                    page: { limit: 20 },
                }),
            ],
        };
        const encoded = Schema.encodeSync(json)(document);
        expect(Schema.decodeUnknownSync(json)(encoded)).toEqual(document);
        expect(JSON.parse(encoded).select[1].value.query.from.source.ontology).toBe("reference");
    });

    it("keeps scalar branching, conditional selection, query tests and singular/plural shapes distinct", () => {
        const query = approvals();
        const document: QueryDocument = {
            select: [
                value("eligible", some(query)),
                value(
                    "label",
                    o.Expression.conditional({
                        condition: literal(true),
                        whenTrue: literal("allowed"),
                        whenFalse: literal("denied"),
                    })
                ),
                when(literal(false), [nested("optional", query, "one")]),
                nested("oneApproval", query, "one"),
                nested("approvalList", { ...query, page: { limit: 1 } }),
            ],
        };
        expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(document))).toEqual(document);
        expect(document.select[3]).not.toEqual(document.select[4]);
    });

    it("rejects unknown wire operators and malformed nested query/cardinality shapes", () => {
        const decode = Schema.decodeUnknownSync(codec);
        expect(() =>
            decode({
                select: [
                    value("bad", {
                        kind: "operation",
                        value: { operator: "raw-sql", arguments: [] },
                    } as never),
                ],
            })
        ).toThrow(/operator/);
        expect(() =>
            decode({
                select: [
                    {
                        kind: "query",
                        value: {
                            name: "bad",
                            query: approvals(),
                            cardinality: "maybe",
                        },
                    },
                ],
            })
        ).toThrow(/cardinality/);
        expect(() =>
            decode({ select: [nested("missingSource", { ...approvals(), from: undefined } as never)] })
        ).toThrow(/from/);
    });

    it("does not silently enable query expressions in the existing action-default evaluator", () => {
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
                            defaultValue: some(approvals()),
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
