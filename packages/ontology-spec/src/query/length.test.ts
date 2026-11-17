import { Schema } from "effect";
import { expect, test } from "vitest";
import { compileEffectSchemas } from "../codecs/compiler.js";
import { o } from "../ir/generated/builders.js";
import irSchema from "../ir/schema.js";
import { certain } from "../utils/uncertain.js";
import { eq, evaluateOperator, field, length, literal, validateQueryDocument } from "./index.js";
import type { Expression, OntologyIR, QueryDocument } from "../ir/generated/types.js";

const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "id", type: o.string({}) },
                { name: "rank", displayName: "rank", type: o.optional({ type: o.integer({}) }) },
                {
                    name: "labels",
                    displayName: "labels",
                    type: o.optional({ type: o.list({ elementType: o.string({}) }) }),
                },
            ],
        },
    ],
    linkTypes: [],
};
const issues = (where: Expression): QueryDocument => ({
    select: [
        {
            kind: "sub",
            value: {
                name: "issues",
                cardinality: "many",
                query: { from: { source: { objectType: "Issue" }, binding: "i" }, where, select: [] },
            },
        },
    ],
});

test("length counts list elements and string code units, and a missing value as 0", () => {
    expect(evaluateOperator("length", [certain(["a", "b"])])).toEqual(certain(2));
    expect(evaluateOperator("length", [certain([])])).toEqual(certain(0));
    expect(evaluateOperator("length", [certain("héllo")])).toEqual(certain(5));
    expect(evaluateOperator("length", [certain(undefined)])).toEqual(certain(0));
    expect(evaluateOperator("length", [certain(null)])).toEqual(certain(0));
    expect(() => evaluateOperator("length", [certain(3)])).toThrow("LENGTH requires a list or string.");
});

test("length is an integer over a list or string, and round-trips on the wire", () => {
    const query = issues(eq(length(field("i", "labels")), literal(0)));
    expect(validateQueryDocument(ir, query)).toEqual([]);
    expect(
        validateQueryDocument(ir, issues(eq(length(field("i", "rank")), literal(0)))).map(
            (issue) => issue.message
        )
    ).toContain("LENGTH requires a list or string operand.");
    const codec = Schema.fromJsonString(
        Schema.toCodecJson(compileEffectSchemas(irSchema).namedSchemas.QueryDocument!)
    );
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(query))).toEqual(query);
});
