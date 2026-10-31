import { fc } from "@fast-check/vitest";
import { o } from "@party-stack/ontology-spec";
import {
    context,
    contains,
    eq,
    and,
    gt,
    exists,
    field,
    literal,
    selectCase,
    selectField,
    sub,
    caseExpression,
} from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { policyView } from "./policy.js";
import { executeQuery, queryExecutor } from "./query.js";
import type { QueryReader } from "./query.js";
import type { OntologyIR, QueryDocument } from "@party-stack/ontology-spec";
import type { Query as Scan } from "@party-stack/ontology-storage";

const text = o.string({});
const p = (name: string, type: import("@party-stack/ontology-spec").TypeDef = text) => ({
    name,
    displayName: name,
    type,
});
const ir: OntologyIR = {
    types: [],
    actionTypes: [],
    queryFunctionTypes: [],
    linkTypes: [],
    context: { type: o.struct({ fields: [p("user")] }) },
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [p("id"), p("title"), p("admins", o.list({ elementType: text }))],
        },
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [p("id"), p("projectId"), p("title"), p("rank", o.integer({})), p("secret")],
        },
    ],
};
const issueQuery = () => ({
    from: { source: { objectType: "Issue" }, binding: "i" },
    where: eq(field("i", "projectId"), field("p", "id")),
    orderBy: [{ expression: field("i", "rank"), direction: "desc" as const }],
    page: { limit: 2 },
    select: [selectField("id", field("i", "id")), selectField("title", field("i", "title"))],
});
const document = (): QueryDocument => ({
    select: [
        sub("projects", {
            from: { source: { objectType: "Project" }, binding: "p" },
            where: contains(field("p", "admins"), context("user")),
            select: [
                selectField("id", field("p", "id")),
                sub("issues", issueQuery()),
                selectField("hasIssues", exists(issueQuery())),
            ],
        }),
    ],
});
function reader(data: Record<string, Record<string, unknown>[]>, definition = ir) {
    const calls: { objectType: string; query?: Scan }[] = [];
    const source: QueryReader = {
        ir: definition,
        loadSubset: (objectType, query) => {
            calls.push({ objectType, query });
            return Effect.succeed(
                evaluateQuery(
                    (data[objectType] ?? []).map((value) => ({ key: value.id as string, value })),
                    query ?? {}
                )
            );
        },
    };
    return { source, calls };
}
const projects = [
    { id: "a", title: "A", admins: ["user"] },
    { id: "b", title: "B", admins: [] },
];

it("invalid policy configuration is a typed failure, not an Effect defect", async () => {
    const { source } = reader({});
    const result = await Effect.runPromise(policyView(source, {}).pipe(Effect.result));
    expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BackendError", kind: "InvalidConfiguration" },
    });
});

describe("finite hierarchical queries", () => {
    it.each([false, true])("batches child equality correlations (reversed: %s)", async (reversed) => {
        const parentRows = Array.from({ length: 12 }, (_, i) => ({
            id: `p${i}`,
            title: `P${i}`,
            admins: [],
        }));
        const issues = parentRows.flatMap((project, i) => [
            { id: `i${i}`, projectId: project.id, title: `Issue ${i}`, rank: i },
            { id: `excluded${i}`, projectId: project.id, title: "Excluded", rank: -1 },
        ]);
        const child = {
            ...issueQuery(),
            page: undefined,
            where: and(
                reversed
                    ? eq(field("p", "id"), field("i", "projectId"))
                    : eq(field("i", "projectId"), field("p", "id")),
                gt(field("i", "rank"), literal(-1))
            ),
        };
        const query: QueryDocument = {
            select: [
                sub("projects", {
                    from: { source: { objectType: "Project" }, binding: "p" },
                    select: [selectField("id", field("p", "id")), sub("issues", child)],
                }),
            ],
        };
        const planned = reader({ Project: parentRows, Issue: issues });
        const reference = reader({ Project: parentRows, Issue: issues });
        const result = await Effect.runPromise(executeQuery(query, { reader: planned.source }));
        expect(result.value).toEqual(
            (
                await Effect.runPromise(
                    executeQuery(query, { reader: reference.source, strategy: "reference" })
                )
            ).value
        );
        const calls = planned.calls.filter((call) => call.objectType === "Issue");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.query).toMatchObject({
            where: {
                op: "and",
                predicates: expect.arrayContaining([
                    {
                        op: "in",
                        left: { _tag: "Field", path: ["projectId"] },
                        values: expect.arrayContaining(parentRows.map((row) => row.id)),
                    },
                ]),
            },
        });
        expect(reference.calls.filter((call) => call.objectType === "Issue")).toHaveLength(12);
    });
    it("bounds child IN lists and skips empty parent results", async () => {
        const query: QueryDocument = {
            select: [
                sub("projects", {
                    from: { source: { objectType: "Project" }, binding: "p" },
                    select: [sub("issues", { ...issueQuery(), page: undefined })],
                }),
            ],
        };
        const parents = Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, title: "", admins: [] }));
        const { source, calls } = reader({ Project: parents, Issue: [] });
        await Effect.runPromise(executeQuery(query, { reader: source }));
        const children = calls.filter((call) => call.objectType === "Issue");
        expect(children).toHaveLength(3);
        expect(children.map((call) => call.query?.where)).toMatchObject([
            { predicates: [{ values: expect.any(Array) }] },
            { predicates: [{ values: expect.any(Array) }] },
            { predicates: [{ values: expect.any(Array) }] },
        ]);
        expect(
            children.map((call) =>
                call.query?.where?.op === "and" && call.query.where.predicates[0]?.op === "in"
                    ? call.query.where.predicates[0].values.length
                    : -1
            )
        ).toEqual([256, 256, 88]);
        const empty = reader({ Project: [], Issue: [] });
        expect((await Effect.runPromise(executeQuery(query, { reader: empty.source }))).value).toEqual({
            projects: [],
        });
        expect(empty.calls.map((call) => call.objectType)).toEqual(["Project"]);
    });
    it("matches a domain oracle with duplicate correlation keys and missing children", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.record({
                        project: fc.integer({ min: 0, max: 3 }),
                        rank: fc.integer({ min: -3, max: 3 }),
                    }),
                    { maxLength: 35 }
                ),
                async (data) => {
                    const parents = Array.from({ length: 6 }, (_, i) => ({
                        id: `p${i}`,
                        title: `group${i % 3}`,
                        admins: [],
                    }));
                    const issues = data.map((row, i) => ({
                        id: `i${String(i).padStart(2, "0")}`,
                        projectId: `group${row.project}`,
                        title: `Issue ${i}`,
                        rank: row.rank,
                    }));
                    const query: QueryDocument = {
                        select: [
                            sub("projects", {
                                from: { source: { objectType: "Project" }, binding: "p" },
                                select: [
                                    selectField("id", field("p", "id")),
                                    sub("issues", {
                                        ...issueQuery(),
                                        page: undefined,
                                        where: and(
                                            eq(field("i", "projectId"), field("p", "title")),
                                            gt(field("i", "rank"), literal(0))
                                        ),
                                    }),
                                ],
                            }),
                        ],
                    };
                    const expected = {
                        projects: parents.map((parent) => ({
                            id: parent.id,
                            issues: issues
                                .filter((issue) => issue.projectId === parent.title && issue.rank > 0)
                                .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
                                .map(({ id, title }) => ({ id, title })),
                        })),
                    };
                    for (const strategy of ["planned", "reference"] as const) {
                        const { source } = reader({ Project: parents, Issue: issues });
                        expect(
                            (await Effect.runPromise(executeQuery(query, { reader: source, strategy }))).value
                        ).toEqual(expected);
                    }
                }
            ),
            { numRuns: 60 }
        );
    });
    it("keeps per-parent top-K queries on the ordinary path", async () => {
        const parents = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, title: "", admins: [] }));
        const issues = parents.flatMap((parent, p) =>
            Array.from({ length: 4 }, (_, i) => ({
                id: `i${p}-${i}`,
                title: `Issue ${i}`,
                projectId: parent.id,
                rank: i,
            }))
        );
        const query: QueryDocument = {
            select: [
                sub("projects", {
                    from: { source: { objectType: "Project" }, binding: "p" },
                    select: [sub("issues", { ...issueQuery(), page: { limit: 1 } })],
                }),
            ],
        };
        const { source, calls } = reader({ Project: parents, Issue: issues });
        expect((await Effect.runPromise(executeQuery(query, { reader: source }))).value).toEqual({
            projects: parents.map((_, p) => ({ issues: [{ id: `i${p}-3`, title: "Issue 3" }] })),
        });
        expect(calls.filter((call) => call.objectType === "Issue")).toHaveLength(3);
    });
    it("does not batch residual filters that depend on another parent property", async () => {
        const parents = [
            { id: "a", title: "A", admins: [] },
            { id: "b", title: "B", admins: [] },
        ];
        const query: QueryDocument = {
            select: [
                sub("projects", {
                    from: { source: { objectType: "Project" }, binding: "p" },
                    select: [
                        sub("issues", {
                            ...issueQuery(),
                            page: undefined,
                            where: and(
                                eq(field("i", "projectId"), field("p", "id")),
                                eq(field("i", "title"), field("p", "title"))
                            ),
                        }),
                    ],
                }),
            ],
        };
        const { source, calls } = reader({
            Project: parents,
            Issue: [
                { id: "a1", title: "A", projectId: "a", rank: 1 },
                { id: "a2", title: "B", projectId: "a", rank: 2 },
                { id: "b1", title: "B", projectId: "b", rank: 1 },
            ],
        });
        expect((await Effect.runPromise(executeQuery(query, { reader: source }))).value).toEqual({
            projects: [{ issues: [{ id: "a1", title: "A" }] }, { issues: [{ id: "b1", title: "B" }] }],
        });
        expect(calls.filter((call) => call.objectType === "Issue")).toHaveLength(2);
    });
    it("uses the same explicit null ordering for residual cursor filtering and source pagination", async () => {
        const definition = structuredClone(ir);
        definition.objectTypes
            .find((t) => t.name === "Issue")!
            .properties.find((p) => p.name === "rank")!.type = o.optional({ type: o.integer({}) });
        const rows = [
            { id: "a", rank: undefined },
            { id: "b", rank: -1 },
            { id: "c", rank: 1 },
        ];
        for (const direction of ["asc", "desc"] as const)
            for (const nulls of ["first", "last"] as const) {
                const document: QueryDocument = {
                    select: [
                        sub("items", {
                            from: { source: { objectType: "Issue" }, binding: "i" },
                            orderBy: [{ expression: field("i", "rank"), direction, nulls }],
                            page: { after: { values: [undefined], key: "a" } },
                            select: [selectField("id", field("i", "id"))],
                        }),
                    ],
                };
                const results = [];
                for (const strategy of ["planned", "reference"] as const) {
                    const { source } = reader({ Issue: rows }, definition);
                    results.push(
                        (await Effect.runPromise(executeQuery(document, { reader: source, strategy }))).value
                    );
                }
                expect(results[0]).toEqual(results[1]);
                expect(results[0]).toEqual({
                    items:
                        nulls === "last"
                            ? []
                            : (direction === "asc" ? ["b", "c"] : ["c", "b"]).map((id) => ({ id })),
                });
            }
    });
    it("matches an independent domain oracle for planned and reference strategies", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.record({ project: fc.boolean(), rank: fc.integer({ min: -5, max: 5 }) }), {
                    maxLength: 20,
                }),
                async (rows) => {
                    const issues = rows.map((r, n) => ({
                        id: `i${String(n).padStart(2, "0")}`,
                        title: `Issue ${n}`,
                        projectId: r.project ? "a" : "b",
                        rank: r.rank,
                        secret: "hidden",
                    }));
                    const expected = {
                        projects: [
                            {
                                id: "a",
                                issues: issues
                                    .filter((i) => i.projectId === "a")
                                    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
                                    .slice(0, 2)
                                    .map(({ id, title }) => ({ id, title })),
                                hasIssues: issues.some((i) => i.projectId === "a"),
                            },
                        ],
                    };
                    for (const strategy of ["planned", "reference"] as const) {
                        const { source } = reader({ Project: projects, Issue: issues });
                        const result = await Effect.runPromise(
                            executeQuery(document(), { reader: source, context: { user: "user" }, strategy })
                        );
                        expect(result.value).toEqual(expected);
                    }
                }
            ),
            { numRuns: 60 }
        );
    });
    it("pushes correlations/windows and does not choose ELSE for unknown conditions", async () => {
        const { source, calls } = reader({ Project: projects, Issue: [] });
        await Effect.runPromise(executeQuery(document(), { reader: source, context: { user: "user" } }));
        expect(calls.some((c) => c.objectType === "Issue" && c.query?.where && c.query.limit === 2)).toBe(
            true
        );
        const executor = queryExecutor({ reader: source, knownInputs: new Set() });
        expect(
            await Effect.runPromise(
                executor.evaluate(
                    caseExpression({
                        branches: [
                            {
                                condition: o.Expression.inputReference({ name: "missing" }),
                                result: literal("then"),
                            },
                        ],
                        else: literal("else"),
                    })
                )
            )
        ).toEqual({ certain: false });
    });
    it("projects policy cells and preserves top-K grants when a caller narrows the request", async () => {
        const definition = structuredClone(ir);
        definition.policy = {
            read: {
                select: [
                    sub("issues", {
                        from: { source: { objectType: "Issue" }, binding: "i" },
                        orderBy: [{ expression: field("i", "rank"), direction: "desc" }],
                        page: { limit: 1 },
                        select: [
                            selectField("id", field("i", "id")),
                            selectField("title", field("i", "title")),
                            selectCase({
                                branches: [
                                    {
                                        condition: eq(context("user"), literal("admin")),
                                        select: [selectField("secret", field("i", "secret"))],
                                    },
                                ],
                            }),
                        ],
                    }),
                ],
            },
        };
        const { source } = reader(
            {
                Issue: [
                    { id: "first", title: "First", rank: 2, projectId: "a", secret: "private" },
                    { id: "last", title: "Last", rank: 1, projectId: "a", secret: "private" },
                ],
            },
            definition
        );
        const view = await Effect.runPromise(policyView(source, { user: "user" }));
        const rows = await Effect.runPromise(view.tx.loadSubset("Issue"));
        expect(rows.map((r) => r.value)).toEqual([{ id: "first", title: "First" }]);
        expect(await Effect.runPromise(view.tx.get("Issue", "last"))).toBeUndefined();
    });
});

it("Query IR aliases retain attachment/encrypted provenance without selecting the primary key", async () => {
    const definition = structuredClone(ir);
    definition.objectTypes
        .find((type) => type.name === "Issue")!
        .properties.push(p("file", o.attachment({})), p("encrypted", o.encrypted({ type: text })));
    definition.policy = {
        read: {
            select: [
                sub("issues", {
                    from: { source: { objectType: "Issue" }, binding: "i" },
                    select: ["id", "file", "encrypted"].map((name) => selectField(name, field("i", name))),
                }),
            ],
        },
    };
    const value = {
        id: "issue",
        file: { id: "bytes" },
        encrypted: { ciphertext: "opaque" },
        secret: "hidden",
    };
    const { source } = reader({ Issue: [value] }, definition);
    const view = await Effect.runPromise(policyView(source, { user: "user" }));
    const document: QueryDocument = {
        select: [
            sub("issues", {
                from: { source: { objectType: "Issue" }, binding: "i" },
                select: [
                    selectField("download", field("i", "file")),
                    selectField("secured", field("i", "encrypted")),
                ],
            }),
        ],
    };
    const result = await Effect.runPromise(
        executeQuery(document, { reader: view.reader, canReadProperty: view.canReadProperty })
    );
    expect(result.value).toEqual({
        issues: [
            {
                download: {
                    id: "bytes",
                    source: { objectType: "Issue", primaryKey: "issue", property: "file" },
                },
                secured: {
                    ciphertext: "opaque",
                    source: { objectType: "Issue", primaryKey: "issue", property: "encrypted" },
                },
            },
        ],
    });
    expect(value).toEqual({
        id: "issue",
        file: { id: "bytes" },
        encrypted: { ciphertext: "opaque" },
        secret: "hidden",
    });
    const forbidden: QueryDocument = {
        select: [
            sub("issues", {
                from: { source: { objectType: "Issue" }, binding: "i" },
                select: [selectField("leak", field("i", "secret"))],
            }),
        ],
    };
    expect(
        (
            await Effect.runPromise(
                executeQuery(forbidden, { reader: view.reader, canReadProperty: view.canReadProperty })
            )
        ).value
    ).toEqual({ issues: [{}] });
    const probe: QueryDocument = {
        select: [
            sub("issues", {
                from: { source: { objectType: "Issue" }, binding: "i" },
                where: eq(field("i", "secret"), literal("hidden")),
                select: [selectField("id", field("i", "id"))],
            }),
        ],
    };
    expect(
        await Effect.runPromise(
            executeQuery(probe, { reader: view.reader, canReadProperty: view.canReadProperty }).pipe(
                Effect.result
            )
        )
    ).toMatchObject({ _tag: "Failure", failure: { kind: "Forbidden" } });
});
