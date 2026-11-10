import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { PinnedContent } from "./Pinned.js";
import { subsetQuery } from "./queryIR.js";
import { QueryDocumentView, QueryExpression } from "./QueryView.js";
import type { Expression, OntologyIR, PinStatus, Query, QueryDocument } from "@party-stack/ontology";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: ["Folder", "Note", "Attachment"].map((name) => ({
        name,
        displayName: name,
        pluralDisplayName: `${name}s`,
        primaryKey: "id",
        properties: [],
    })),
};
const literal = (value: unknown): Expression => ({ kind: "literal", value: { value } });
const field = (binding: string, name: string): Expression => ({
    kind: "getAt",
    value: { source: { kind: "localReference", value: { name: binding } }, path: [name] },
});
const query = (objectType: string, binding: string): Query => ({
    from: { source: { objectType }, binding },
    select: [],
});
const graph: QueryDocument = {
    inputs: [
        {
            name: "search",
            displayName: "Search",
            type: { kind: "optional", value: { type: { kind: "string", value: {} } } },
        },
    ],
    select: [
        {
            kind: "sub",
            value: {
                name: "folders",
                cardinality: "many",
                query: {
                    ...query("Folder", "folder"),
                    select: [
                        { kind: "field", value: { name: "name", expression: field("folder", "name") } },
                        {
                            kind: "sub",
                            value: {
                                name: "notes",
                                cardinality: "many",
                                query: {
                                    ...query("Note", "note"),
                                    where: {
                                        kind: "eq",
                                        value: {
                                            left: field("note", "folderId"),
                                            right: field("folder", "id"),
                                        },
                                    },
                                    orderBy: [
                                        {
                                            expression: field("note", "updatedAt"),
                                            direction: "desc",
                                            nulls: "first",
                                        },
                                    ],
                                    page: {
                                        limit: 10,
                                        offset: 0,
                                        after: { key: "last-note", values: ["yesterday"] },
                                    },
                                    select: [
                                        {
                                            kind: "field",
                                            value: { name: "title", expression: field("note", "title") },
                                        },
                                        {
                                            kind: "sub",
                                            value: {
                                                name: "files",
                                                cardinality: "many",
                                                query: {
                                                    ...query("Attachment", "file"),
                                                    where: {
                                                        kind: "eq",
                                                        value: {
                                                            left: field("file", "noteId"),
                                                            right: field("note", "id"),
                                                        },
                                                    },
                                                    select: [
                                                        {
                                                            kind: "field",
                                                            value: {
                                                                name: "bytes",
                                                                expression: field("file", "file"),
                                                            },
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
        },
    ],
};

test("query graphs retain nested selection and correlation boundaries, cardinality and windows", () => {
    const markup = renderToStaticMarkup(createElement(QueryDocumentView, { query: graph, ir }));
    expect(markup.match(/class="ps-query-node"/g)).toHaveLength(3);
    for (const text of [
        "Folders",
        "Notes",
        "Attachments",
        "folder.name",
        "note.folderId",
        "folder.id",
        "file.noteId",
        "note.id",
        "file.file",
        "nulls first",
        "last-note",
        "yesterday",
    ])
        expect(markup).toContain(text);
    expect(markup).toMatch(/folders[^]*?notes[^]*?files/);
    expect(markup).toContain('class="ps-query-keyword">offset</span>');
    expect(markup).toContain('class="ps-query-cardinality">many</span>');
    expect(markup).toContain("search: String (optional)");
});

test("conditional selections and expression subqueries remain visible instead of becoming JSON blobs", () => {
    const document: QueryDocument = {
        select: [
            {
                kind: "selectCase",
                value: {
                    branches: [
                        {
                            condition: { kind: "inputReference", value: { name: "showNotes" } },
                            select: graph.select,
                        },
                    ],
                    else: [
                        {
                            kind: "field",
                            value: {
                                name: "allowed",
                                expression: {
                                    kind: "exists",
                                    value: { query: query("Note", "allowedNote") },
                                },
                            },
                        },
                    ],
                },
            },
        ],
    };
    const markup = renderToStaticMarkup(createElement(QueryDocumentView, { query: document, ir }));
    for (const text of ["WHEN", "input.showNotes", "ELSE", "EXISTS", "allowedNote"])
        expect(markup).toContain(text);
    expect(markup.match(/class="ps-query-node"/g)).toHaveLength(4);
});

test("portable expression variants preserve links, context, transformations and escaped literals", () => {
    const expressions: Expression[] = [
        { kind: "lookup", value: { reference: field("note", "ownerId") } },
        {
            kind: "related",
            value: { source: { kind: "localReference", value: { name: "note" } }, link: "author" },
        },
        {
            kind: "getAt",
            value: { source: { kind: "contextReference", value: { name: "user" } }, path: ["id"] },
        },
        { kind: "struct", value: { fields: [{ name: "safe", value: literal("<script>bad</script>") }] } },
        {
            kind: "map",
            value: {
                source: literal(["a", "b"]),
                binding: "item",
                body: { kind: "localReference", value: { name: "item" } },
            },
        },
        {
            kind: "case",
            value: { branches: [{ condition: literal(true), result: literal("yes") }], else: literal("no") },
        },
        { kind: "concat", value: { expressions: [literal("a"), literal("b")] } },
        { kind: "coalesce", value: { expressions: [literal(undefined), literal(null)] } },
        { kind: "uuid", value: {} },
        { kind: "now", value: {} },
    ];
    const markup = expressions
        .map((expression) => renderToStaticMarkup(createElement(QueryExpression, { expression })))
        .join("");
    for (const text of [
        "lookup",
        "author",
        "context.user.id",
        "safe",
        "map",
        "item",
        "CASE",
        "when",
        "then",
        "else",
        "concat",
        "coalesce",
        "undefined",
        "null",
        "uuid()",
        "now()",
    ])
        expect(markup).toContain(text);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
});

test("literal arrays and records retain undefined, null and bigint values", () => {
    const markup = renderToStaticMarkup(
        createElement(QueryExpression, { expression: literal({ values: [undefined, null, 12n] }) })
    );
    expect(markup).toContain("values");
    expect(markup).toContain("undefined");
    expect(markup).toContain("null");
    expect(markup).toContain("12n");
});

test("subset adaptation preserves absence, nullish values, zero limits and cursor keys", () => {
    const converted = subsetQuery("Note", {
        where: { op: "eq", left: { _tag: "Field", path: ["missing"] }, right: undefined },
        limit: 0,
        offset: 0,
        after: { key: 0, values: [null] },
    });
    expect(converted.where).toEqual({
        kind: "eq",
        value: { left: field("row", "missing"), right: literal(undefined) },
    });
    expect(converted.page).toEqual({ limit: 0, offset: 0, after: { key: 0, values: [null] } });
    expect(subsetQuery("Note").where).toBeUndefined();
});

test("the pinned view distinguishes empty, loading, ready and retained replacement failures", () => {
    const render = (props: Omit<Parameters<typeof PinnedContent>[0], "ir">) =>
        renderToStaticMarkup(createElement(PinnedContent, { ir, ...props }));
    expect(render({})).toContain("No pinned graph.");
    expect(render({ loading: true })).toContain('aria-label="Reading pinned graph"');
    const status: PinStatus = { query: graph, attachments: "all", ready: true, previousGraphRetained: false };
    const ready = render({ status });
    expect(ready).toContain("Available offline");
    expect(ready).toContain("Includes attachment bytes");
    expect(ready).toContain("Pinned query graph");
    expect(render({ status: { ...status, ready: false } })).toContain("Loading pinned graph");
    const failed = render({
        status: {
            ...status,
            ready: false,
            attachments: "none",
            previousGraphRetained: true,
            error: { kind: "Unavailable", message: "Connection lost" },
        },
    });
    expect(failed).toContain("Download interrupted");
    expect(failed).toContain("Connection lost");
    expect(failed).toContain("previous graph is retained");
    expect(failed).toContain("Objects only");
    expect(failed).not.toContain("Available offline");
});
