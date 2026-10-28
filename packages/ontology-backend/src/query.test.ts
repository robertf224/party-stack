import { fc } from "@fast-check/vitest";
import { o } from "@party-stack/ontology-spec";
import {
    context,
    contains,
    eq,
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

describe("finite hierarchical queries", () => {
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
        const view = policyView(source, { user: "user" });
        const rows = await Effect.runPromise(view.tx.loadSubset("Issue"));
        expect(rows.map((r) => r.value)).toEqual([{ id: "first", title: "First" }]);
        expect(await Effect.runPromise(view.tx.get("Issue", "last"))).toBeUndefined();
    });
});
