import { Schema } from "effect";
import { expect, test } from "vitest";
import { compileEffectSchemas } from "../codecs/compiler.js";
import { o } from "../ir/generated/builders.js";
import irSchema from "../ir/schema.js";
import {
    and,
    eq,
    exists,
    field,
    literal,
    related,
    resolveQuerySources,
    local,
    selectField,
    sub,
    validateQueryDocument,
} from "./index.js";
import type { OntologyIR, QueryDocument, QuerySource } from "../ir/generated/types.js";

const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Project", "Issue"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: name,
        primaryKey: "id",
        properties: ["id", "projectId"].map((name) => ({ name, displayName: name, type: o.string({}) })),
    })),
    linkTypes: [
        {
            id: "projectIssues",
            source: { objectType: "Issue", name: "issues", displayName: "Issues" },
            target: { objectType: "Project", name: "project", displayName: "Project" },
            foreignKey: "projectId",
            cardinality: "many",
        },
    ],
};
const document = (source: QuerySource = related(local("p"), "issues")): QueryDocument => ({
    select: [
        sub("projects", {
            from: { source: { objectType: "Project" }, binding: "p" },
            select: [
                sub("issues", {
                    from: { source, binding: "i" },
                    where: eq(field("i", "id"), literal("one")),
                    page: { limit: 2 },
                    select: [],
                }),
            ],
        }),
    ],
});

test("related sources round-trip on the wire and lower to the explicit join", () => {
    const query = document();
    const codec = Schema.fromJsonString(
        Schema.toCodecJson(compileEffectSchemas(irSchema).namedSchemas.QueryDocument!)
    );
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(query))).toEqual(query);
    expect(validateQueryDocument(ir, query, { mode: "entity" })).toEqual([]);
    expect(resolveQuerySources(ir, query)).toEqual({
        select: [
            sub("projects", {
                from: { source: { objectType: "Project" }, binding: "p" },
                select: [
                    sub("issues", {
                        from: { source: { objectType: "Issue" }, binding: "i" },
                        where: and(
                            eq(field("i", "projectId"), field("p", "id")),
                            eq(field("i", "id"), literal("one"))
                        ),
                        page: { limit: 2 },
                        select: [],
                    }),
                ],
            }),
        ],
    });
});

test.each([
    [{}, "requires"],
    [related(local("missing"), "issues"), "ancestor"],
    [related(local("p"), "missing"), "link"],
    [related(literal("p"), "issues"), "ancestor"],
    [{ ...related(local("p"), "issues"), objectType: "Issue" }, "inherits"],
    [{ ...related(local("p"), "issues"), ontology: "other" }, "inherits"],
] satisfies [QuerySource, string][])("rejects invalid sources before execution: %j", (source, message) => {
    expect(validateQueryDocument(ir, document(source)).some((issue) => issue.message.includes(message))).toBe(
        true
    );
});

test("link sources inherit a named ontology and work inside EXISTS", () => {
    const child = { from: { source: related(local("i"), "project"), binding: "p" }, select: [] };
    const query: QueryDocument = {
        select: [
            sub("issues", {
                from: { source: { ontology: "remote", objectType: "Issue" }, binding: "i" },
                select: [selectField("hasProject", exists(child))],
            }),
        ],
    };
    expect(validateQueryDocument(ir, query, { sources: { remote: ir } })).toEqual([]);
    const expected: QueryDocument = {
        select: [
            sub("issues", {
                from: { source: { ontology: "remote", objectType: "Issue" }, binding: "i" },
                select: [
                    selectField(
                        "hasProject",
                        exists({
                            ...child,
                            from: { source: { ontology: "remote", objectType: "Project" }, binding: "p" },
                            where: eq(field("p", "id"), field("i", "projectId")),
                        })
                    ),
                ],
            }),
        ],
    };
    expect(resolveQuerySources(ir, query, { remote: ir })).toEqual(expected);
});

test("self links resolve direction by endpoint name and ambiguous links fail", () => {
    const self: OntologyIR = {
        ...ir,
        linkTypes: [
            {
                ...ir.linkTypes[0]!,
                source: { objectType: "Project", name: "children", displayName: "Children" },
                target: { objectType: "Project", name: "parent", displayName: "Parent" },
            },
        ],
    };
    for (const name of ["children", "parent"])
        expect(validateQueryDocument(self, document(related(local("p"), name)))).toEqual([]);
    const ambiguous = { ...ir, linkTypes: [...ir.linkTypes, { ...ir.linkTypes[0]!, id: "duplicate" }] };
    expect(validateQueryDocument(ambiguous, document())[0]?.message).toContain("ambiguous");
});
