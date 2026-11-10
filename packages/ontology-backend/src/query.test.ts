import { it } from "@effect/vitest";
import { o } from "@party-stack/ontology-spec";
import {
    related,
    local,
    context,
    contains,
    eq,
    and,
    gt,
    exists,
    input,
    or,
    field,
    literal,
    selectCase,
    selectField,
    sub,
    caseExpression,
} from "@party-stack/ontology-spec/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { makeOwnedBackend } from "./owned.js";
import { authorizeAction, policyView } from "./policy.js";
import { executeQuery, queryExecutor, makeOntologyBackend } from "./query.js";
import { compileObjectSubset } from "./subset.js";
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
    linkTypes: [
        {
            id: "issueProject",
            source: { objectType: "Issue", name: "issues", displayName: "Issues" },
            target: { objectType: "Project", name: "project", displayName: "Project" },
            foreignKey: "projectId",
            cardinality: "many",
        },
    ],
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
    from: { source: related(local("p"), "issues"), binding: "i" },
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

it("backend queries use bound context and keep caller inputs separate", async () => {
    const source = reader({ Project: projects, Issue: [] }).source;
    const backend = makeOntologyBackend({
        ir,
        context: { user: "user" },
        name: "provider",
        sourceId: "provider",
        supportsIdempotency: false,
        loadSubset: (request) =>
            compileObjectSubset(ir, request).pipe(
                Effect.flatMap((subset) => source.loadSubset(subset.objectType, subset.query)),
                Effect.map((rows) => ({ rows, complete: true }))
            ),
        applyAction: () => Effect.die("unused"),
        queryFunction: () => Effect.die("unused"),
    });
    const query: QueryDocument = {
        ...document(),
        inputs: [p("user")],
        select: [
            ...document().select,
            selectField("principal", context("user")),
            selectField("argument", input("user")),
        ],
    };
    expect(await Effect.runPromise(backend.query(query, { inputs: { user: "spoofed" } }))).toEqual({
        projects: [{ id: "a", issues: [], hasIssues: false }],
        principal: "user",
        argument: "spoofed",
    });
    const incomplete = makeOntologyBackend({
        ...backend,
        ir,
        query: undefined,
        loadSubset: () => Effect.succeed({ rows: [], complete: false }),
    });
    expect(await Effect.runPromise(incomplete.query(document()).pipe(Effect.result))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "InvalidResponse" },
    });
});

it("query aliases preserve the source property of attachment and encrypted handles", async () => {
    const definition: OntologyIR = {
        ...ir,
        context: undefined,
        objectTypes: [
            {
                ...ir.objectTypes[0]!,
                properties: [
                    p("id"),
                    p("file", o.attachment({})),
                    p("secret", o.encrypted({ type: o.string({}) })),
                ],
            },
        ],
    };
    const backend = makeOntologyBackend({
        ir: definition,
        name: "handles",
        sourceId: "handles",
        supportsIdempotency: false,
        loadSubset: () =>
            Effect.succeed({
                complete: true,
                rows: [
                    {
                        key: "a",
                        value: {
                            id: "a",
                            file: { id: "file" },
                            secret: { ciphertext: "encrypted" },
                        },
                    },
                ],
            }),
        applyAction: () => Effect.die("unused"),
        queryFunction: () => Effect.die("unused"),
    });
    const result = await Effect.runPromise(
        backend.query({
            select: [
                sub("projects", {
                    from: { source: { objectType: "Project" }, binding: "project" },
                    select: [
                        selectField("download", field("project", "file")),
                        selectField("value", field("project", "secret")),
                    ],
                }),
            ],
        })
    );
    expect(result.projects).toEqual([
        {
            download: { id: "file", source: { objectType: "Project", primaryKey: "a", property: "file" } },
            value: {
                ciphertext: "encrypted",
                source: { objectType: "Project", primaryKey: "a", property: "secret" },
            },
        },
    ]);
});

it("owned hierarchical queries share one read transaction, and provider-native queries bypass subset fallback", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let snapshots = 0;
                const owned = yield* makeOwnedBackend({
                    ir,
                    namespace: "native-query",
                    mutators: {},
                    tables: {
                        ...tables,
                        read: (body) => {
                            snapshots++;
                            return tables.read(body);
                        },
                    },
                });
                yield* owned.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("Project", projects[0]!);
                        yield* tx.put("Issue", {
                            id: "i",
                            projectId: "a",
                            title: "Issue",
                            rank: 1,
                            secret: "private",
                        });
                    })
                );
                snapshots = 0;
                const answer = yield* owned.query({
                    select: [
                        sub("projects", {
                            from: { source: { objectType: "Project" }, binding: "p" },
                            select: [selectField("id", field("p", "id")), sub("issues", issueQuery())],
                        }),
                    ],
                });
                expect(answer).toEqual({ projects: [{ id: "a", issues: [{ id: "i", title: "Issue" }] }] });
                expect(snapshots).toBe(1);
                const native = makeOntologyBackend({
                    ...owned,
                    ir,
                    query: () => Effect.succeed({ native: true }),
                    loadSubset: () => Effect.die("Native query loaded a subset"),
                });
                expect(yield* native.query(document())).toEqual({ native: true });
            })
        )
    );
});

it("invalid policy configuration is a typed failure, not an Effect defect", async () => {
    const { source } = reader({});
    const result = await Effect.runPromise(policyView(source, {}).pipe(Effect.result));
    expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BackendError", kind: "InvalidConfiguration" },
    });
});

it("related policy grants authorize only linked rows and selected properties", async () => {
    const definition: OntologyIR = {
        ...ir,
        policy: {
            objects: {
                select: [
                    sub("projects", {
                        from: { source: { objectType: "Project" }, binding: "p" },
                        where: contains(field("p", "admins"), context("user")),
                        select: [sub("issues", { ...issueQuery(), page: undefined })],
                    }),
                ],
            },
        },
    };
    const { source } = reader(
        {
            Project: projects,
            Issue: [
                { id: "allowed", projectId: "a", title: "Visible", rank: 1, secret: "private" },
                { id: "denied", projectId: "b", title: "Hidden", rank: 2, secret: "private" },
            ],
        },
        definition
    );
    const view = await Effect.runPromise(policyView(source, { user: "user" }));
    expect(await Effect.runPromise(view.tx.get("Issue", "allowed"))).toEqual({
        id: "allowed",
        title: "Visible",
    });
    expect(await Effect.runPromise(view.tx.get("Issue", "denied"))).toBeUndefined();
});

describe("finite hierarchical queries", () => {
    it("follows foreign keys with nullable/dangling targets and inherits named sources", async () => {
        const remote = reader({
            Project: projects,
            Issue: [
                { id: "one", projectId: "a" },
                { id: "null", projectId: null },
                { id: "dangling", projectId: "missing" },
            ],
        });
        const query: QueryDocument = {
            select: [
                sub("issues", {
                    from: { source: { ontology: "remote", objectType: "Issue" }, binding: "i" },
                    select: [
                        selectField("id", field("i", "id")),
                        sub(
                            "project",
                            {
                                from: { source: related(local("i"), "project"), binding: "p" },
                                select: [selectField("title", field("p", "title"))],
                            },
                            "one"
                        ),
                    ],
                }),
            ],
        };
        const result = await Effect.runPromise(
            executeQuery(query, { reader: reader({}).source, sources: { remote: remote.source } })
        );
        expect(result.value).toEqual({
            issues: [
                { id: "dangling", project: undefined },
                { id: "null", project: undefined },
                { id: "one", project: { title: "A" } },
            ],
        });
        expect(remote.calls.filter((call) => call.objectType === "Project")).toHaveLength(1);
    });
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
            from: { source: { objectType: "Issue" }, binding: "i" },
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
    it.live.prop(
        "matches a domain oracle with duplicate correlation keys and missing children",
        [
            Schema.Array(
                Schema.Struct({
                    project: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
                    rank: Schema.Int.check(Schema.isBetween({ minimum: -3, maximum: 3 })),
                })
            ).check(Schema.isMaxLength(35)),
        ],
        ([data]) =>
            Effect.gen(function* () {
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
                                    from: { source: { objectType: "Issue" }, binding: "i" },
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
                    expect((yield* executeQuery(query, { reader: source, strategy })).value).toEqual(
                        expected
                    );
                }
            }),
        { arbitrary: { runs: 60 } }
    );
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
    it.live.prop(
        "matches an independent domain oracle for planned and reference strategies",
        [
            Schema.Array(
                Schema.Struct({
                    project: Schema.Boolean,
                    rank: Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5 })),
                })
            ).check(Schema.isMaxLength(20)),
        ],
        ([rows]) =>
            Effect.gen(function* () {
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
                    const result = yield* executeQuery(document(), {
                        reader: source,
                        context: { user: "user" },
                        strategy,
                    });
                    expect(result.value).toEqual(expected);
                }
            }),
        { arbitrary: { runs: 60 } }
    );
    it("keeps an existential action check uncertain until its draft parameter is known", async () => {
        const definition = structuredClone(ir);
        definition.actionTypes = [
            { name: "edit", displayName: "Edit", parameters: [p("project")], logic: [] },
        ];
        definition.policy = {
            objects: { select: [] },
            actions: [
                {
                    actionType: "edit",
                    check: exists({
                        from: { source: { objectType: "Project" }, binding: "p" },
                        where: eq(field("p", "id"), input("project")),
                        select: [],
                    }),
                },
            ],
        };
        const { source } = reader({ Project: projects }, definition);
        const check = (parameters: Record<string, unknown>, known: string[]) =>
            Effect.runPromise(
                authorizeAction(source, { user: "user" }, "edit", parameters, new Set(known))
            ).then((result) => result.check);
        expect(await check({}, [])).toEqual({ certain: false });
        expect(await check({ project: "a" }, ["project"])).toEqual({ certain: true, value: true });
        expect(await check({ project: "missing" }, ["project"])).toEqual({ certain: true, value: false });
    });
    it("proves EXISTS from known matches without treating missing input as a denial", async () => {
        const query = {
            from: { source: { objectType: "Project" }, binding: "p" },
            where: or(eq(field("p", "id"), literal("a")), eq(field("p", "id"), input("project"))),
            select: [],
        };
        for (const strategy of ["planned", "reference"] as const) {
            const { source } = reader({ Project: projects });
            const executor = queryExecutor({ reader: source, knownInputs: new Set(), strategy });
            expect(await Effect.runPromise(executor.evaluate(exists(query)))).toEqual({
                certain: true,
                value: true,
            });
            expect(
                await Effect.runPromise(executor.evaluate(exists({ ...query, page: { offset: 1 } })))
            ).toEqual({ certain: false });
            expect(
                await Effect.runPromise(executor.evaluate(exists({ ...query, page: { limit: 0 } })))
            ).toEqual({ certain: true, value: false });
            const empty = queryExecutor({
                reader: reader({ Project: [] }).source,
                knownInputs: new Set(),
                strategy,
            });
            expect(await Effect.runPromise(empty.evaluate(exists(query)))).toEqual({
                certain: true,
                value: false,
            });
            const strict = await Effect.runPromise(
                Effect.result(
                    executor.run({
                        inputs: [p("project")],
                        select: [sub("projects", query)],
                    })
                )
            );
            expect(strict).toMatchObject({ _tag: "Failure", failure: { kind: "Forbidden" } });
        }
    });
    it.live.prop(
        "never proves an existential draft check contradicted by a completed input",
        [
            Schema.Array(Schema.Boolean).check(Schema.isMaxLength(12)),
            Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 })),
            Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
        ],
        ([known, offset, limit]) =>
            Effect.gen(function* () {
                const data = known.map((match, i) => ({
                    id: `p${i}`,
                    title: match ? "known" : "other",
                    admins: [],
                }));
                const query = {
                    from: { source: { objectType: "Project" }, binding: "p" },
                    where: or(
                        eq(field("p", "title"), literal("known")),
                        eq(field("p", "id"), input("project"))
                    ),
                    page: { offset, limit },
                    select: [],
                };
                const completions = ["missing", ...data.map((r) => r.id)].map(
                    (project) =>
                        limit > 0 &&
                        data.filter((r) => r.title === "known" || r.id === project).length > offset
                );
                for (const strategy of ["planned", "reference"] as const) {
                    const result = yield* queryExecutor({
                        reader: reader({ Project: data }).source,
                        knownInputs: new Set(),
                        strategy,
                    }).evaluate(exists(query));
                    if (result.certain)
                        expect(completions.every((value) => value === result.value)).toBe(true);
                    if (limit > 0 && known.filter(Boolean).length > offset)
                        expect(result).toEqual({ certain: true, value: true });
                }
            }),
        { arbitrary: { runs: 100 } }
    );
    it("keeps structural equality out of scalar storage predicates", async () => {
        for (const strategy of ["planned", "reference"] as const) {
            const { source, calls } = reader({ Project: projects });
            const result = await Effect.runPromise(
                executeQuery(
                    {
                        select: [
                            sub("projects", {
                                from: { source: { objectType: "Project" }, binding: "p" },
                                where: eq(field("p", "admins"), field("p", "admins")),
                                page: { limit: 1 },
                                select: [selectField("id", field("p", "id"))],
                            }),
                        ],
                    },
                    { reader: source, strategy }
                )
            );
            expect(result.value).toEqual({ projects: [{ id: "a" }] });
            expect(calls[0]?.query?.where).toBeUndefined();
            expect(calls[0]?.query?.limit).toBeUndefined();
        }
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
            objects: {
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
        objects: {
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
