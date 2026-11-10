import { IR } from "@tanstack/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { diagnosticTargets } from "./diagnostics.js";
import { QueryLoadStats } from "./Queries.js";
import { QueryPills, nullOrderLabel, predicateText } from "./QueryPills.js";
import { QueryPushdown, RequestedQuery } from "./QueryPushdown.js";
import { demandId, diagnosticSpans, queryLoads } from "./replicationActivity.js";
import { schemaLinkLabel, schemaRelationship } from "./schemaLayout.js";
import { operationRows, spanSubtree, traceStatus } from "./traceTimeline.js";
import { groupTraces, traceWaterfall } from "./traceWaterfall.js";
import type { PerformanceSpan } from "./traceWaterfall.js";
import type { OntologyIR } from "@party-stack/ontology";

test("subset identity survives storage and transport object-key reordering", () => {
    expect(
        demandId({
            objectType: "Note",
            query: { where: { op: "eq", left: { _tag: "Field", path: ["id"] }, right: "one" } },
        })
    ).toBe(
        demandId({
            objectType: "Note",
            query: { where: { right: "one", left: { path: ["id"], _tag: "Field" }, op: "eq" } },
        })
    );
});
const span = (id: string, startedAt: number, durationMs: number, parentId?: string): PerformanceSpan => ({
    id,
    traceId: "sync",
    name: id,
    startedAt,
    durationMs,
    parentId,
    outcome: "success",
    attributes: {},
});

test("pushdown inspection keeps unsupported intent and local work inside a labeled disclosure", () => {
    const demand = { objectType: "Note", query: {}, references: 1, watchers: 0, revision: 1, installed: 1 };
    const request = {
        objectType: "Note",
        query: {},
        exact: false,
        requested: {
            where: new IR.Func("eq", [
                new IR.Func("lower", [new IR.PropRef(["title"])]),
                new IR.Value("urgent"),
            ]),
            limit: 5,
        },
    };
    const markup = renderToStaticMarkup(
        createElement(
            "div",
            null,
            createElement(RequestedQuery, { request, demand }),
            createElement(QueryPushdown, { demand, requests: [request] })
        )
    );
    expect(markup).toContain('aria-label="Requested query"');
    expect(markup).toContain("lower(");
    expect(markup).toContain('class="ps-query-pushdown"');
    expect(markup).toContain(">Query path</span></summary>");
    expect(markup).toContain("Tab replica</h4>");
    expect(markup).toContain("This tab filters the replica’s response");
    expect(markup).toContain("This tab applies the query limit");
    expect(markup).toContain("No recorded source load.");
});

test("provider-independent plans annotate portable predicates and display native syntax as opaque text", () => {
    const where = {
        op: "or" as const,
        predicates: [
            { op: "ilike" as const, left: { _tag: "Field" as const, path: ["title"] }, right: "urgent%" },
            { op: "contains" as const, left: { _tag: "Field" as const, path: ["tags"] }, right: "urgent" },
        ],
    };
    const markup = renderToStaticMarkup(
        createElement(QueryPushdown, {
            demand: {
                objectType: "Note",
                query: { where },
                references: 1,
                watchers: 0,
                revision: 1,
                installed: 1,
            },
            requests: [{ objectType: "Note", exact: false, filterExact: true, orderExact: false }],
            parentReplica: "Shared worker",
            load: {
                id: 1,
                operation: "loadSubset",
                reason: "demand",
                startedAt: 0,
                outcome: "success",
                pushdown: {
                    source: "Example SQL provider",
                    predicates: [
                        { path: [0], execution: "candidate" },
                        { path: [1], execution: "source" },
                    ],
                    sorting: "adapter",
                    pagination: "adapter",
                    rechecksFilter: true,
                    native: {
                        language: "sql",
                        text: "SELECT * FROM notes WHERE title LIKE $1 OR tags @> $2",
                    },
                },
            },
        })
    );
    expect(markup).toMatch(
        /1<\/span>Tab replica<\/h4>[^]*?2<\/span>Shared worker replica<\/h4>[^]*?3<\/span>Example SQL provider/
    );
    expect(markup.match(/class="ps-query-step"/g)).toHaveLength(3);
    expect(markup).not.toContain("ps-query-path");
    expect(markup.match(/<strong>Filter:<\/strong>/g)).toHaveLength(3);
    expect(markup).toContain("Live demand forwarded to the Shared worker replica.");
    expect(markup).toContain("This tab sorts the replica’s response.");
    expect(markup).toContain("Example SQL provider");
    expect(markup).toContain('data-execution="candidate"');
    expect(markup).toContain('data-execution="source"');
    expect(markup).toContain("Partly pushed down to Example SQL provider.");
    expect(markup).toContain("Approximate pushdown");
    expect(markup).toContain("The adapter filters Example SQL provider’s response");
    expect(markup).toContain("The adapter applies the query limit or pagination");
    expect(markup).toContain("Native query (SQL)");
    expect(markup.replace(/<[^>]*>/g, "")).toContain(
        "SELECT * FROM notes WHERE title LIKE $1 OR tags @&gt; $2"
    );
    expect(markup).not.toContain("Foundry");
});

test("exact source filtering does not imply source pagination or an incomplete tab filter was pushed down", () => {
    const query = {
        where: { op: "eq" as const, left: { _tag: "Field" as const, path: ["id"] }, right: "one" },
        limit: 2,
    };
    const demand = { objectType: "Note", query, references: 1, watchers: 0, revision: 1, installed: 1 };
    const load = {
        id: 1,
        operation: "loadSubset" as const,
        reason: "demand" as const,
        startedAt: 0,
        outcome: "success" as const,
        rows: 2,
        fetchedRows: 2,
        pushdown: {
            source: "Example provider",
            predicates: [{ path: [], execution: "source" as const }],
            sorting: "none" as const,
            pagination: "none" as const,
            rechecksFilter: true,
        },
    };
    const render = (exact: boolean, pagination: "adapter" | "none" = "none") =>
        renderToStaticMarkup(
            createElement(QueryPushdown, {
                demand,
                requests: [{ objectType: "Note", exact, query }],
                load: { ...load, pushdown: { ...load.pushdown, pagination } },
            })
        );
    const normal = render(true);
    expect(normal).toContain("Fully pushed down to Example provider.");
    expect(normal.match(/class="ps-query-step"/g)).toHaveLength(2);
    expect(normal).toMatch(/1<\/span>Tab replica<\/h4>[^]*?2<\/span>Example provider/);
    expect(normal).not.toContain("Shared worker replica");
    expect(normal).toContain("Pushed down</span>");
    expect(normal).not.toContain("adapter also checks");
    expect(normal).not.toContain("adapter filters");
    expect(render(true, "adapter")).toContain("adapter applies the query limit or pagination");
    expect(render(false)).toContain("this tab still evaluates the remaining conditions.");
    const unsupported = renderToStaticMarkup(
        createElement(QueryPushdown, {
            demand,
            requests: [],
            load: {
                ...load,
                pushdown: { ...load.pushdown, predicates: [{ path: [], execution: "adapter" }] },
            },
        })
    );
    expect(unsupported).toContain("Not pushed down to Example provider.");
    expect(unsupported).toContain("Not pushed down</span>");
});

test("coverage reuse is reported only with an engine-provided proof, not inferred from broad load history", () => {
    const demand = {
        objectType: "Issue",
        query: {
            where: { op: "ilike" as const, left: { _tag: "Field" as const, path: ["title"] }, right: "hi%" },
        },
        references: 1,
        watchers: 0,
        revision: 1,
        installed: 1,
    };
    const render = (coveredBy?: Parameters<typeof QueryPushdown>[0]["coveredBy"]) =>
        renderToStaticMarkup(
            createElement(QueryPushdown, {
                demand,
                requests: [],
                parentReplica: "Shared worker",
                coveredBy,
            })
        );
    const unknown = render();
    expect(unknown).toContain("No recorded source load.");
    expect(unknown.match(/class="ps-query-step"/g)).toHaveLength(3);
    expect(unknown).toContain("No recorded load");
    const reused = render({ objectType: "Issue" });
    expect(reused).toContain("Satisfied by local coverage; no upstream request needed.");
    expect(reused).toContain("<h5>Coverage</h5>");
    expect(reused).not.toContain("Reads through");
    expect(reused.match(/class="ps-query-step"/g)).toHaveLength(3);
    expect(reused).toMatch(/2<\/span>Shared worker replica<\/h4>[^]*?Satisfied by local coverage/);
    expect(reused).not.toContain("existing data</h4>");
    expect(reused).not.toContain("Coverage could not be determined");
    expect(reused).not.toContain("fully pushed down");
    const local = renderToStaticMarkup(
        createElement(QueryPushdown, { demand, requests: [], coveredBy: { objectType: "Issue" } })
    );
    expect(local.match(/class="ps-query-step"/g)).toHaveLength(2);
    expect(local).toContain("Satisfied by local coverage; no upstream request needed.");
});

test("coverage explanations distinguish exact queries, collections, and primary-key hits", () => {
    const demand = {
        objectType: "User",
        query: { where: { op: "eq" as const, left: { _tag: "Field" as const, path: ["id"] }, right: "one" } },
        references: 1,
        watchers: 1,
        revision: 1,
        installed: 1,
    };
    const render = (
        reason: "query" | "collection" | "primary-key",
        maintainedBy: "watch" | "journal" | "poll"
    ) =>
        renderToStaticMarkup(
            createElement(QueryPushdown, {
                demand,
                requests: [],
                parentReplica: "Shared worker",
                coveredBy: reason === "query" ? demand : { objectType: "User" },
                coverageProof: {
                    reason,
                    maintainedBy,
                    ...(maintainedBy === "poll" ? { pollIntervalMs: 60_000 } : {}),
                },
                load: {
                    id: 1,
                    subset: demand,
                    operation: "loadSubset",
                    reason: "demand",
                    startedAt: 0,
                    outcome: "success",
                },
            })
        );
    const exact = render("query", "watch");
    expect(exact).toContain("Previously loaded complete result of the same query or primary-key lookup.");
    expect(exact).toContain("Refreshed by source change notifications.");
    expect(exact).toContain("Reused this query’s previous result");
    expect(exact.split('class="ps-query-data-details"')[1]?.split("</div>")[0]).not.toContain(
        'class="ps-query-expression"'
    );
    expect(render("query", "poll")).toContain("Refreshed by polling every 1 minute.");
    // The current reuse decision takes precedence over an earlier source load for the same query.
    expect(exact.match(/class="ps-query-step"/g)).toHaveLength(3);
    expect(exact).not.toContain("Requested from");
    expect(exact).toContain('data-source-state="cached"');
    expect(exact).toContain("Skipped · replica cache hit");
    expect(exact).not.toContain("<h5>Last source load</h5>");
    expect(exact).toMatch(
        /data-source-state="cached"[^]*?<strong>Filter:<\/strong>[^]*?<strong>Data:<\/strong>/
    );
    expect(exact).not.toContain("ps-query-previous-load");
    const collection = render("collection", "journal");
    expect(collection).toContain("Complete collection; includes every matching row.");
    expect(collection).toContain("Refreshed through journal catch-up.");
    expect(render("primary-key", "watch")).toContain(
        "Requested primary key is present in this maintained result."
    );
});

test("refreshes retain the previous source plan and row counts in the fixed source tier", () => {
    const demand = { objectType: "Note", references: 1, watchers: 1, revision: 2, installed: 1 };
    const previousLoad = {
        id: 1,
        operation: "loadSubset" as const,
        reason: "demand" as const,
        startedAt: 0,
        outcome: "success" as const,
        rows: 8,
        complete: true,
        pushdown: {
            source: "Example source",
            predicates: [],
            sorting: "none" as const,
            pagination: "none" as const,
            rechecksFilter: false,
            native: { language: "sql", text: "SELECT * FROM notes" },
        },
    };
    const markup = renderToStaticMarkup(
        createElement(QueryPushdown, {
            demand,
            requests: [],
            parentReplica: "Shared worker",
            checking: true,
            previousLoad,
            load: { id: 2, operation: "loadSubset", reason: "refresh", startedAt: 1, outcome: "running" },
            loadStats: createElement(QueryLoadStats, { load: previousLoad }),
        })
    );
    expect(markup.match(/class="ps-query-step"/g)).toHaveLength(3);
    expect(markup).toContain('data-source-state="refreshing"');
    expect(markup).toContain('data-stage-state="active"');
    expect(markup).toContain("Example source");
    expect(markup).toContain("Source request in progress");
    expect(markup).toContain("Loaded <b>8</b> rows");
    expect(markup).toContain("SELECT");
    expect(markup).toContain("Complete result from the last source load.");
    expect(markup).not.toContain("Request in progress");
});

test("predicate annotation paths survive flattened AND groups and NOT", () => {
    const eq = (name: string) => ({
        op: "eq" as const,
        left: { _tag: "Field" as const, path: [name] },
        right: true,
    });
    const markup = renderToStaticMarkup(
        createElement(QueryPills, {
            query: {
                where: {
                    op: "and",
                    predicates: [
                        eq("first"),
                        { op: "and", predicates: [eq("second"), { op: "not", predicate: eq("third") }] },
                    ],
                },
            },
            annotations: [
                { path: [0], execution: "source" },
                { path: [1, 0], execution: "candidate" },
                { path: [1, 1, 0], execution: "adapter" },
            ],
        })
    );
    expect(markup).toMatch(/data-execution="source"[^]*?first/);
    expect(markup).toMatch(/data-execution="candidate"[^]*?second/);
    expect(markup).toMatch(/data-execution="adapter"[^]*?third/);
});

test("stopped subscriptions and cancelled requests do not appear as failures, including evicted traces", () => {
    const stopped = {
        ...span("Demand", 0, 5),
        outcome: "interrupted" as const,
        attributes: { activity: "subscription" },
    };
    expect(traceStatus(stopped)).toBe("Stopped");
    expect(traceStatus({ ...stopped, attributes: {} })).toBe("Cancelled");
    expect(traceStatus({ ...stopped, outcome: "failure" })).toBe("Failed");
    expect(groupTraces([stopped])[0]?.failed).toBe(false);
    expect(
        diagnosticSpans(
            [],
            [
                {
                    id: 1,
                    operation: "loadSubset",
                    reason: "demand",
                    startedAt: 0,
                    finishedAt: 5,
                    outcome: "interrupted",
                },
            ]
        )[0]?.outcome
    ).toBe("interrupted");
});

test("waterfall preserves gaps, parallel children, and self time without double-counting", () => {
    const chart = traceWaterfall(
        [
            span("root", 100, 20),
            span("a", 102, 8, "root"),
            span("b", 106, 8, "root"),
            span("nested", 107, 1, "b"),
        ],
        120
    );
    expect(chart.duration).toBe(20);
    expect(chart.rows.map((row) => [row.span.id, row.depth, row.offset, row.self])).toEqual([
        ["root", 0, 0, 8],
        ["a", 1, 2, 8],
        ["b", 1, 6, 7],
        ["nested", 2, 7, 1],
    ]);
});

test("evicted parents, sub-millisecond spans, running work and malformed cycles remain inspectable", () => {
    const chart = traceWaterfall(
        [
            span("orphan", 100.1, 0.2, "evicted"),
            { ...span("active", 100, 0), outcome: "running" },
            span("x", 100, 1, "y"),
            span("y", 100, 1, "x"),
        ],
        102
    );
    expect(chart.duration).toBe(2);
    expect(chart.rows.find((row) => row.span.id === "active")?.duration).toBe(2);
    expect(chart.rows.find((row) => row.span.id === "orphan")?.depth).toBe(0);
    expect(chart.rows).toHaveLength(4);
    const groups = groupTraces([
        span("a", 100, 1),
        { ...span("b", 200, 1), traceId: "later", outcome: "failure" },
    ]);
    expect(groups.map((group) => [group.id, group.failed])).toEqual([
        ["later", true],
        ["sync", false],
    ]);
});

test("timeline request metadata keeps nested spans and survives trace eviction", () => {
    const request = {
        id: 1,
        spanId: "request",
        traceId: "sync",
        operation: "loadSubset" as const,
        reason: "demand" as const,
        subset: { objectType: "Item" },
        startedAt: 101,
        finishedAt: 108,
        outcome: "success" as const,
        rows: 4,
        complete: true,
    };
    const spans = [
        span("root", 100, 10),
        span("request", 101, 7, "root"),
        span("transport", 102, 5, "request"),
    ];
    const activity = diagnosticSpans(spans, [request]);
    expect(activity.map((entry) => entry.id)).toEqual(["root", "request", "transport"]);
    expect(diagnosticSpans([], [request])[0]).toMatchObject({
        id: "request",
        traceId: "sync",
        durationMs: 7,
    });
    // Equal start times and names in a different trace must not acquire this request's query.
    const unrelated = { ...span("request", 101, 7), traceId: "other" };
    const separated = diagnosticSpans([unrelated], [request]);
    expect(separated).toHaveLength(2);
    expect(separated.map((entry) => entry.traceId)).toEqual(["other", "sync"]);
});

test("subscriptions and their requests remain inspectable without expanding nested rows by default", () => {
    const subscription = {
        ...span("watch", 0, 0),
        outcome: "running" as const,
        attributes: { activity: "subscription" },
    };
    const root = span("request", 95_000, 100, "watch");
    const child = span("transport", 95_010, 30, "request");
    const unrelated = { ...span("request", 96_000, 50), traceId: "other" };
    const spans = [subscription, root, child, unrelated];
    const chart = operationRows(spans, 100_000);
    expect(chart.find((row) => row.span.id === "watch")).toMatchObject({ depth: 0 });
    expect(chart.find((row) => row.span.id === "request")).toMatchObject({ depth: 0 });
    expect(chart.find((row) => row.span.id === "transport")).toMatchObject({ depth: 1 });
    expect(spanSubtree(spans, root).map((item) => item.id)).toEqual(["request", "transport"]);
    expect(operationRows([span("done", 10, 20)], 100_000)).toHaveLength(1);
});

test("readable query predicates preserve boolean groups, field references and special values", () => {
    const status = { _tag: "Field" as const, path: ["status"] };
    expect(
        predicateText({
            op: "and",
            predicates: [
                {
                    op: "or",
                    predicates: [
                        { op: "eq", left: status, right: "Open" },
                        { op: "ilike", left: status, right: "%wait%" },
                    ],
                },
                { op: "not", predicate: { op: "in", left: status, values: ["Closed", null] } },
            ],
        })
    ).toBe(
        '((status = "Open" OR status matches (ignore case) "%wait%") AND NOT (status in ["Closed", null]))'
    );
    expect(predicateText({ op: "eq", left: status, right: undefined })).toBe("status is undefined");
    expect(predicateText({ op: "eq", left: status, right: { _tag: "Field", path: ["other"] } })).toBe(
        "status = other"
    );
});

test("execution contexts describe host role separately from worker placement and local-only topology", () => {
    const replica = { getSnapshot: () => ({}), subscribe: () => () => undefined };
    const host = { role: "host" as const, location: "In process", replica };
    expect(diagnosticTargets(host).map((target) => target.label)).toEqual(["This tab"]);
    const worker = { ...host, location: "Shared worker" };
    expect(
        diagnosticTargets({ label: "This tab", role: "replica", replica, parent: worker }).map(
            (target) => target.label
        )
    ).toEqual(["This tab", "Shared worker"]);
});

test("query rendering distinguishes nullish values and pattern wildcards without annotating ordinary strings", () => {
    const field = { _tag: "Field" as const, path: ["title"] };
    const render = (op: "eq" | "like", right: string | null | undefined) =>
        renderToStaticMarkup(
            createElement(QueryPills, {
                query: {
                    where:
                        op === "like" ? { op, left: field, right: right ?? "" } : { op, left: field, right },
                },
            })
        );
    expect(render("eq", null)).toContain('class="ps-query-special"');
    expect(render("eq", undefined)).toContain(">undefined</span>");
    expect(render("eq", "null")).toContain('class="ps-query-literal"');
    const pattern = render("like", "%a_b%");
    expect(pattern.match(/class="ps-query-wildcard"/g)).toHaveLength(3);
    expect(pattern).toContain('title="Any sequence of characters"');
    expect(pattern).toContain('title="One character"');
    expect(render("eq", "%a_b%")).not.toContain("ps-query-wildcard");
    expect(nullOrderLabel({ direction: "asc", nulls: "first" })).toBe("");
    expect(nullOrderLabel({ direction: "desc", nulls: "last" })).toBe("");
    expect(nullOrderLabel({ direction: "desc", nulls: "first" })).toBe(" · nulls first");
    expect(nullOrderLabel({ direction: "asc", nulls: "last" })).toBe(" · nulls last");
});

test("upstream row counts correlate only exact recorded queries, preserving unknown and zero", () => {
    const demand = {
        objectType: "Issue",
        query: { where: { op: "eq" as const, left: { _tag: "Field" as const, path: ["id"] }, right: "one" } },
    };
    const loads = [
        {
            id: 1,
            startedAt: 10,
            operation: "loadSubset" as const,
            reason: "demand" as const,
            outcome: "success" as const,
            subset: { objectType: "Issue" },
            rows: 400,
            fetchedRows: 500,
        },
        {
            id: 2,
            startedAt: 20,
            operation: "loadSubset" as const,
            reason: "demand" as const,
            outcome: "success" as const,
            subset: demand,
            rows: 0,
            fetchedRows: 0,
        },
        {
            id: 3,
            startedAt: 30,
            operation: "loadSubset" as const,
            reason: "demand" as const,
            outcome: "running" as const,
            subset: { ...demand, objectType: "Other" },
        },
    ];
    expect(queryLoads(demand, loads).map((load) => [load.id, load.fetchedRows, load.rows])).toEqual([
        [2, 0, 0],
    ]);
    expect(queryLoads({ objectType: "Unseen" }, loads)).toEqual([]);
});

test("query load summary reports recorded row counts without placeholder requests or duplicate limits", () => {
    const load = {
        id: 1,
        startedAt: 0,
        operation: "loadSubset" as const,
        reason: "demand" as const,
        outcome: "success" as const,
        rows: 8,
        fetchedRows: 50,
    };
    const render = (props: Parameters<typeof QueryLoadStats>[0]) =>
        renderToStaticMarkup(createElement(QueryLoadStats, props)).replace(/<[^>]*>/g, "");
    expect(render({ load })).toBe("Loaded 50 rows; 8 sent to replica after adapter processing.");
    expect(render({ load: { ...load, fetchedRows: 8 } })).toBe("Loaded 8 rows");
    expect(render({ load: { ...load, rows: 0, fetchedRows: 0 } })).toBe("Loaded 0 rows");
    expect(render({ load: { ...load, rows: 1, fetchedRows: 1 } })).toBe("Loaded 1 row");
    expect(render({ load: { ...load, fetchedRows: undefined } })).toBe("Loaded 8 rows");
    expect(render({ load, replicaName: "Shared worker replica" })).toBe(
        "Loaded 50 rows; 8 sent to Shared worker replica after adapter processing."
    );
    expect(
        render({
            load: {
                ...load,
                pushdown: {
                    source: "Example provider",
                    predicates: [],
                    sorting: "none",
                    pagination: "adapter",
                    rechecksFilter: true,
                },
            },
        })
    ).toBe("Loaded 50 rows; 8 sent to replica after adapter filtering and pagination.");
    expect(render({})).toBe("");
    expect(render({ load: { ...load, outcome: "running" } })).toBe("Request in progress…");
    const query = renderToStaticMarkup(createElement(QueryPills, { query: { limit: 20 } }));
    expect(query).toContain('class="ps-query-keyword">limit</span>');
    expect(query).toContain(">20</span>");
});

test("schema arrows describe referenced objects to dependents, preserving side labels and true one-to-one links", () => {
    const ir: OntologyIR = {
        types: [],
        actionTypes: [],
        queryFunctionTypes: [],
        linkTypes: [],
        objectTypes: [
            {
                name: "Issue",
                displayName: "Issue",
                pluralDisplayName: "Issues",
                primaryKey: "id",
                properties: [],
            },
            {
                name: "Project",
                displayName: "Project",
                pluralDisplayName: "Projects",
                primaryKey: "id",
                properties: [],
            },
        ],
    };
    const link = {
        id: "issue-project",
        source: { objectType: "Issue", name: "issues", displayName: "Issue" },
        target: { objectType: "Project", name: "project", displayName: "Project" },
        foreignKey: "projectId",
        cardinality: "many" as const,
    };
    expect(schemaRelationship(link)).toMatchObject({
        source: "Project",
        target: "Issue",
        label: "one-to-many",
        cardinality: "many",
    });
    expect(schemaLinkLabel(ir, link.target, "one")).toBe("one Project");
    expect(schemaLinkLabel(ir, { ...link.source, displayName: "Assigned work" }, "many")).toBe(
        "many Assigned work"
    );
    expect(schemaRelationship({ ...link, cardinality: "one" })).toMatchObject({
        label: "one-to-one",
        cardinality: "one",
    });
});
