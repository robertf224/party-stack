import { fc } from "@fast-check/vitest";
import { o } from "@party-stack/ontology-spec";
import {
    contains,
    context,
    eq,
    field,
    literal,
    selectCase,
    selectField,
    sub,
} from "@party-stack/ontology-spec/query";
import {
    and,
    eq as scanEq,
    field as scanField,
    evaluateQuery,
    or,
    lt,
    not,
} from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { policyIndexes } from "./policy/indexes.js";
import { evaluatePolicyView } from "./policy/view.js";
import type { QueryReader } from "./query.js";
import type { OntologyIR, QuerySelection, TypeDef } from "@party-stack/ontology-spec";
import type { Query as Scan } from "@party-stack/ontology-storage";

const property = (name: string, type: TypeDef = o.string({})) => ({ name, displayName: name, type });
const definition = (): OntologyIR => ({
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    context: { type: o.struct({ fields: [property("user")] }) },
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [property("id"), property("admins", o.list({ elementType: o.string({}) }))],
        },
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                property("id"),
                property("title"),
                property("projectId"),
                property("rank", o.integer({})),
                property("secret"),
            ],
        },
    ],
});
const fields = (binding: string): QuerySelection[] => [
    ...["id", "title", "projectId", "rank"].map((p) => selectField(p, field(binding, p))),
    selectCase({
        branches: [
            {
                condition: eq(context("user"), literal("admin")),
                select: [selectField("secret", field(binding, "secret"))],
            },
        ],
    }),
];
function reader(ir: OntologyIR, data: Record<string, Record<string, unknown>[]>) {
    const calls: { objectType: string; query?: Scan; returned: number }[] = [];
    const source: QueryReader = {
        ir,
        loadSubset: (objectType, query) => {
            const rows = evaluateQuery(
                (data[objectType] ?? []).map((value) => ({ key: value.id as string, value })),
                query ?? {}
            );
            calls.push({ objectType, query, returned: rows.length });
            return Effect.succeed(rows);
        },
    };
    return { source, calls };
}
const strategies = ["rewrite", "eager"] as const;

describe("authorization planning", () => {
    it("prepares bounded indexes for policy predicates/correlations rather than selected output fields", () => {
        const ir = definition();
        ir.policy = {
            read: {
                select: [
                    sub("projects", {
                        from: { source: { objectType: "Project" }, binding: "p" },
                        where: contains(field("p", "admins"), context("user")),
                        select: [
                            sub("issues", {
                                from: { source: { objectType: "Issue" }, binding: "i" },
                                where: eq(field("i", "projectId"), field("p", "id")),
                                select: fields("i"),
                            }),
                        ],
                    }),
                ],
            },
        };
        const indexes = policyIndexes(ir);
        expect(indexes).toEqual(
            expect.arrayContaining([
                {
                    objectType: "Project",
                    index: expect.objectContaining({
                        field: { _tag: "Field", path: ["admins"] },
                        multiEntry: true,
                    }),
                },
                {
                    objectType: "Issue",
                    index: expect.objectContaining({ field: { _tag: "Field", path: ["projectId"] } }),
                },
            ])
        );
        expect(indexes.some((entry) => entry.index.field.path[0] === "secret")).toBe(false);
        expect(indexes.some((entry) => entry.index.field.path[0] === "title")).toBe(false);
    });
    it("both strategies agree with a domain oracle over hierarchical grants, windows and cell guards", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.record({
                        project: fc.integer({ min: 0, max: 2 }),
                        rank: fc.integer({ min: -5, max: 5 }),
                    }),
                    { maxLength: 24 }
                ),
                fc.record({
                    admin: fc.boolean(),
                    policyLimit: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
                    policyOffset: fc.integer({ min: 0, max: 2 }),
                    filter: fc.integer({ min: 0, max: 3 }),
                    selected: fc.integer({ min: 0, max: 24 }),
                    desc: fc.boolean(),
                    limit: fc.integer({ min: 0, max: 8 }),
                    offset: fc.integer({ min: 0, max: 3 }),
                    extraGrant: fc.boolean(),
                    after: fc.boolean(),
                }),
                async (generated, options) => {
                    const ir = definition();
                    const user = options.admin ? "admin" : "user";
                    const projects = [
                        { id: "p0", admins: ["user", "admin"] },
                        { id: "p1", admins: ["admin"] },
                        { id: "p2", admins: [] },
                    ];
                    const issues = generated.map((r, i) => ({
                        id: `i${String(i).padStart(2, "0")}`,
                        title: `Issue ${i}`,
                        projectId: `p${r.project}`,
                        rank: r.rank,
                        secret: "private",
                    }));
                    ir.policy = {
                        read: {
                            select: [
                                sub("projects", {
                                    from: { source: { objectType: "Project" }, binding: "p" },
                                    where: contains(field("p", "admins"), context("user")),
                                    select: [
                                        selectField("id", field("p", "id")),
                                        sub("issues", {
                                            from: { source: { objectType: "Issue" }, binding: "i" },
                                            where: eq(field("i", "projectId"), field("p", "id")),
                                            orderBy: [{ expression: field("i", "rank"), direction: "desc" }],
                                            page:
                                                options.policyLimit === undefined &&
                                                options.policyOffset === 0
                                                    ? undefined
                                                    : {
                                                          limit: options.policyLimit,
                                                          offset: options.policyOffset,
                                                      },
                                            select: fields("i"),
                                        }),
                                    ],
                                }),
                                ...(options.extraGrant
                                    ? [
                                          sub("extra", {
                                              from: { source: { objectType: "Issue" }, binding: "extra" },
                                              where: eq(field("extra", "rank"), literal(0)),
                                              select: fields("extra"),
                                          }),
                                      ]
                                    : []),
                            ],
                        },
                    };
                    const id = `i${String(options.selected).padStart(2, "0")}`;
                    const where =
                        options.filter === 0
                            ? undefined
                            : options.filter === 1
                              ? scanEq(scanField("id"), id)
                              : options.filter === 2
                                ? or(scanEq(scanField("id"), id), lt(scanField("rank"), 0))
                                : and(not(scanEq(scanField("projectId"), "p2")), lt(scanField("rank"), 2));
                    const matches = (i: (typeof issues)[number]) =>
                        options.filter === 0 ||
                        (options.filter === 1
                            ? i.id === id
                            : options.filter === 2
                              ? i.id === id || i.rank < 0
                              : i.projectId !== "p2" && i.rank < 2);
                    const query: Scan = {
                        where,
                        orderBy: [{ field: scanField("rank"), direction: options.desc ? "desc" : "asc" }],
                        limit: options.limit,
                        ...(options.after ? { after: { values: [0], key: id } } : { offset: options.offset }),
                    };
                    const grants = new Map<string, (typeof issues)[number]>();
                    for (const project of projects.filter((p) => p.admins.includes(user))) {
                        const selected = issues
                            .filter((i) => i.projectId === project.id)
                            .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
                            .slice(
                                options.policyOffset,
                                options.policyLimit === undefined
                                    ? undefined
                                    : options.policyOffset + options.policyLimit
                            );
                        for (const issue of selected) grants.set(issue.id, issue);
                    }
                    if (options.extraGrant)
                        for (const issue of issues.filter((i) => i.rank === 0)) grants.set(issue.id, issue);
                    const sorted = [...grants.values()]
                        .filter(matches)
                        .sort(
                            (a, b) => (a.rank - b.rank) * (options.desc ? -1 : 1) || a.id.localeCompare(b.id)
                        );
                    const visible = options.after
                        ? sorted.filter((r) =>
                              r.rank === 0 ? r.id > id : options.desc ? r.rank < 0 : r.rank > 0
                          )
                        : sorted.slice(options.offset);
                    const expected = visible
                        .slice(0, options.limit)
                        .map(({ secret, ...row }) => (options.admin ? { ...row, secret } : row));
                    for (const strategy of strategies) {
                        const { source } = reader(ir, { Project: projects, Issue: issues });
                        const rows = await Effect.runPromise(
                            evaluatePolicyView(source, { user }, undefined, strategy).tx.loadSubset(
                                "Issue",
                                query
                            )
                        );
                        expect(rows.map((r) => r.value)).toEqual(expected);
                    }
                }
            ),
            { numRuns: 120 }
        );
    });

    it("rewrites a keyed request into policy scans instead of acquiring all authorized rows", async () => {
        const ir = definition();
        ir.policy = {
            read: {
                select: [
                    sub("issues", {
                        from: { source: { objectType: "Issue" }, binding: "i" },
                        select: fields("i"),
                    }),
                ],
            },
        };
        const issues = Array.from({ length: 1000 }, (_, i) => ({
            id: `i${i}`,
            title: "Title",
            projectId: "p0",
            rank: i,
            secret: "private",
        }));
        const counts: number[] = [];
        for (const strategy of strategies) {
            const { source, calls } = reader(ir, { Issue: issues });
            const rows = await Effect.runPromise(
                evaluatePolicyView(source, { user: "user" }, undefined, strategy).tx.get("Issue", "i123")
            );
            expect(rows).toEqual({ id: "i123", title: "Title", projectId: "p0", rank: 123 });
            counts.push(calls.reduce((n, c) => n + c.returned, 0));
        }
        expect(counts).toEqual([1, 1000]);
    });

    it("does not narrow an ancestor away from a same-type descendant grant", async () => {
        const ir = definition();
        ir.policy = {
            read: {
                select: [
                    sub("parents", {
                        from: { source: { objectType: "Issue" }, binding: "parent" },
                        where: eq(field("parent", "id"), literal("parent")),
                        select: [
                            selectField("id", field("parent", "id")),
                            selectField("title", field("parent", "title")),
                            sub("children", {
                                from: { source: { objectType: "Issue" }, binding: "child" },
                                where: eq(field("child", "projectId"), field("parent", "id")),
                                select: [
                                    selectField("id", field("child", "id")),
                                    selectField("title", field("child", "title")),
                                ],
                            }),
                        ],
                    }),
                ],
            },
        };
        for (const strategy of strategies) {
            const { source } = reader(ir, {
                Issue: [
                    { id: "parent", title: "Parent", projectId: "" },
                    { id: "child", title: "Child", projectId: "parent" },
                ],
            });
            expect(
                await Effect.runPromise(
                    evaluatePolicyView(source, { user: "user" }, undefined, strategy).tx.get("Issue", "child")
                )
            ).toEqual({ id: "child", title: "Child" });
        }
    });

    it("preserves first-match selection branches and refuses hidden-field probes before reading", async () => {
        const ir = definition();
        ir.policy = {
            read: {
                select: [
                    selectCase({
                        branches: [
                            { condition: literal(true), select: [] },
                            {
                                condition: literal(true),
                                select: [
                                    sub("issues", {
                                        from: { source: { objectType: "Issue" }, binding: "i" },
                                        select: fields("i"),
                                    }),
                                ],
                            },
                        ],
                    }),
                ],
            },
        };
        for (const strategy of strategies) {
            const { source, calls } = reader(ir, {
                Issue: [{ id: "i", title: "Hidden", rank: 1, projectId: "p", secret: "private" }],
            });
            const view = evaluatePolicyView(source, { user: "user" }, undefined, strategy);
            expect(await Effect.runPromise(view.tx.get("Issue", "i"))).toBeUndefined();
            const before = calls.length;
            const result = await Effect.runPromise(
                Effect.result(view.tx.loadSubset("Issue", { where: scanEq(scanField("secret"), "private") }))
            );
            expect(result._tag).toBe("Failure");
            expect(calls).toHaveLength(before);
        }
    });
});

it("narrows a token's Post Approval/Bid grant while preserving the final caller window", async () => {
    const ir: OntologyIR = {
        types: [],
        linkTypes: [],
        actionTypes: [],
        queryFunctionTypes: [],
        context: { type: o.struct({ fields: [property("approvalId")] }) },
        objectTypes: [
            {
                name: "PostApproval",
                displayName: "Post Approval",
                pluralDisplayName: "Post Approvals",
                primaryKey: "id",
                properties: [property("id")],
            },
            {
                name: "Bid",
                displayName: "Bid",
                pluralDisplayName: "Bids",
                primaryKey: "id",
                properties: [
                    property("id"),
                    property("approvalId"),
                    property("status"),
                    property("rank", o.integer({})),
                ],
            },
            {
                name: "Post",
                displayName: "Post",
                pluralDisplayName: "Posts",
                primaryKey: "id",
                properties: [property("id")],
            },
        ],
        policy: {
            read: {
                select: [
                    sub("approval", {
                        from: { source: { objectType: "PostApproval" }, binding: "a" },
                        where: eq(field("a", "id"), context("approvalId")),
                        select: [
                            selectField("id", field("a", "id")),
                            sub("bids", {
                                from: { source: { objectType: "Bid" }, binding: "b" },
                                where: eq(field("b", "approvalId"), field("a", "id")),
                                select: ["id", "approvalId", "status", "rank"].map((name) =>
                                    selectField(name, field("b", name))
                                ),
                            }),
                        ],
                    }),
                    sub("posts", {
                        from: { source: { objectType: "Post" }, binding: "p" },
                        select: [selectField("id", field("p", "id"))],
                    }),
                ],
            },
        },
    };
    const data = {
        PostApproval: [{ id: "approval-42" }, { id: "approval-other" }],
        Bid: [
            { id: "bid-a", approvalId: "approval-42", status: "Waiting", rank: 1 },
            { id: "bid-b", approvalId: "approval-42", status: "Waiting", rank: 2 },
            { id: "bid-c", approvalId: "approval-other", status: "Waiting", rank: 3 },
            { id: "bid-d", approvalId: "approval-42", status: "Done", rank: 4 },
        ],
        Post: [{ id: "post" }],
    };
    const { source, calls } = reader(ir, data);
    const query = {
        where: scanEq(scanField("status"), "Waiting"),
        orderBy: [{ field: scanField("rank"), direction: "desc" as const }],
        limit: 1,
    };
    const planned = await Effect.runPromise(
        evaluatePolicyView(source, { approvalId: "approval-42" }).tx.loadSubset("Bid", query)
    );
    const oracle = await Effect.runPromise(
        evaluatePolicyView(
            reader(ir, data).source,
            { approvalId: "approval-42" },
            undefined,
            "eager"
        ).tx.loadSubset("Bid", query)
    );
    expect(planned).toEqual(oracle);
    expect(planned.map((row) => row.key)).toEqual(["bid-b"]);
    expect(calls.map((call) => call.objectType)).toEqual(["PostApproval", "Bid"]);
    expect(calls[0]!.query?.where).toEqual(scanEq(scanField("id"), "approval-42"));
    expect(calls[1]!.returned).toBe(2);
    expect(calls[1]!.query?.limit).toBeUndefined();
    expect(
        evaluateQuery(
            data.Bid.map((value) => ({ key: value.id, value })),
            calls[1]!.query
        ).map((row) => row.key)
    ).toEqual(["bid-a", "bid-b"]);
});
