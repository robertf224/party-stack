import * as PgliteClient from "@effect/sql-pglite/PgLiteClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { policyView } from "@party-stack/ontology-backend/policy";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { o, type OntologyIR, type QueryDocument, type TypeDef } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { Table, field } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import fc from "fast-check";
import { expect, test } from "vitest";
import { make } from "./tables.js";
import type { QueryReader } from "@party-stack/ontology-backend/query";

const property = (name: string, type: TypeDef = o.string({})) => ({ name, displayName: name, type });
const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    context: { type: o.struct({ fields: [property("allowed", o.boolean({}))] }) },
    objectTypes: [
        {
            name: "Project",
            displayName: "Project",
            pluralDisplayName: "Projects",
            primaryKey: "id",
            properties: [property("id"), property("allowed", o.boolean({}))],
        },
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                property("id"),
                property("projectId"),
                property("title"),
                property("rank", o.optional({ type: o.integer({}) })),
                property("visible", o.boolean({})),
            ],
        },
    ],
};
interface Issue {
    id: string;
    projectId: string;
    title: string;
    rank: number | undefined;
    visible: boolean;
}
const parents = Table.make<Record<string, unknown>>({ name: "ranked-projects" });
const children = Table.make<Record<string, unknown>>({ name: "ranked-issues" });
const selections = ["id", "projectId", "title", "rank"].map((name) =>
    q.selectField(name, q.field("i", name))
);
const childQuery = (limit: number, offset: number, descending: boolean, nulls: "first" | "last") => ({
    from: { source: { objectType: "Issue" }, binding: "i" },
    where: q.and(
        q.eq(q.field("i", "projectId"), q.field("p", "id")),
        q.eq(q.field("i", "visible"), q.literal(true))
    ),
    orderBy: [
        {
            expression: q.field("i", "rank"),
            direction: descending ? ("desc" as const) : ("asc" as const),
            nulls,
        },
    ],
    page: { limit, offset },
    select: selections,
});
const document = (child: ReturnType<typeof childQuery>): QueryDocument => ({
    select: [
        q.sub("projects", {
            from: { source: { objectType: "Project" }, binding: "p" },
            select: [q.selectField("id", q.field("p", "id")), q.sub("issues", child)],
        }),
    ],
});
const select = ({ id, projectId, title, rank }: Issue) => ({ id, projectId, title, rank });

test.each(["sqlite", "pg"] as const)(
    "%s ranked queries match reference/domain and authorization oracles",
    async (dialect) => {
        const program = Effect.gen(function* () {
            const tables = yield* make();
            for (const name of ["id", "allowed"])
                yield* tables.ensureIndex(parents, { name, field: field(name) });
            for (const name of ["id", "projectId", "rank", "visible"])
                yield* tables.ensureIndex(children, { name, field: field(name) });
            const sources = { Project: parents, Issue: children };
            let nativeRows = 0;
            let nativeCalls = 0;
            let declined = 0;
            const run = (doc: QueryDocument, definition = ir, reference = false, authorized = false) =>
                tables.read((tx) =>
                    Effect.gen(function* () {
                        const boundary = <A>(effect: Effect.Effect<A, unknown>) =>
                            effect.pipe(
                                Effect.mapError((cause) => classifyBackendFailure("query.test", cause))
                            );
                        const reader: QueryReader = {
                            ir: definition,
                            loadSubset: (name, query) =>
                                boundary(tx.query(sources[name as keyof typeof sources], query)),
                            ...(!reference
                                ? ({
                                      loadGroupedSubset: (name, partition, query) =>
                                          boundary(
                                              tx.queryGrouped!(
                                                  sources[name as keyof typeof sources],
                                                  partition,
                                                  query
                                              )
                                          ).pipe(
                                              Effect.tap((rows) =>
                                                  Effect.sync(() => {
                                                      if (rows === undefined) declined++;
                                                      else {
                                                          nativeCalls++;
                                                          nativeRows += rows.length;
                                                      }
                                                  })
                                              )
                                          ),
                                  } satisfies Pick<QueryReader, "loadGroupedSubset">)
                                : {}),
                        };
                        const view = authorized ? yield* policyView(reader, { allowed: true }) : undefined;
                        return yield* executeQuery(doc, {
                            reader: view?.reader ?? reader,
                            canReadProperty: view?.canReadProperty,
                            context: { allowed: true },
                            strategy: reference ? "reference" : "planned",
                        });
                    })
                );
            const replace = (data: Issue[], allowed = [true, true, true]) =>
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.clear(parents);
                        yield* tx.clear(children);
                        for (const [i, value] of allowed.entries())
                            yield* tx.put(parents, `p${i}`, { id: `p${i}`, allowed: value });
                        for (const row of data) yield* tx.put(children, row.id, { ...row });
                    })
                );

            const sample: Issue[] = Array.from({ length: 30 }, (_, i) => ({
                id: `i${String(i).padStart(2, "0")}`,
                projectId: `p${i % 3}`,
                title: "matchA",
                rank: i % 5,
                visible: i % 4 !== 0,
            }));
            yield* replace(sample);
            const child = childQuery(2, 1, true, "last");
            const actual = yield* run(document(child));
            expect(actual.value).toEqual((yield* run(document(child), ir, true)).value);
            expect(nativeCalls).toBe(1);
            expect(nativeRows).toBe(6);

            // Title has no native projection here. Ranking before its residual predicate
            // would let a nonmatching high-ranked row displace a matching row.
            const residual = {
                ...childQuery(1, 0, true, "last"),
                where: q.and(child.where, q.like(q.field("i", "title"), q.literal("match_"))),
            };
            yield* replace([
                ...sample,
                { id: "bad", projectId: "p0", title: "matchLong", rank: 100, visible: true },
            ]);
            expect((yield* run(document(residual))).value).toEqual(
                (yield* run(document(residual), ir, true)).value
            );
            expect(declined).toBeGreaterThan(0);
            yield* tables.ensureIndex(children, { name: "title", field: field("title") });
            const beforeLike = nativeCalls;
            expect((yield* run(document(residual))).value).toEqual(
                (yield* run(document(residual), ir, true)).value
            );
            expect(nativeCalls).toBe(beforeLike + 1);

            const context = yield* Effect.context<never>();
            const execute = Effect.runPromiseWith(context);
            yield* Effect.promise(() =>
                fc.assert(
                    fc.asyncProperty(
                        fc.array(
                            fc.record({
                                group: fc.integer({ min: 0, max: 3 }),
                                rank: fc.option(fc.integer({ min: -3, max: 3 }), { nil: undefined }),
                                visible: fc.boolean(),
                            }),
                            { maxLength: 45 }
                        ),
                        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
                        fc.integer({ min: 0, max: 4 }),
                        fc.integer({ min: 0, max: 3 }),
                        fc.boolean(),
                        fc.boolean(),
                        async (rows, allowed, limit, offset, descending, nullsFirst) => {
                            const data: Issue[] = rows.map((row, i) => ({
                                id: `i${String(i).padStart(2, "0")}`,
                                projectId: `p${row.group}`,
                                rank: row.rank,
                                visible: row.visible,
                                title: "matchA",
                            }));
                            await execute(replace(data, allowed));
                            const nulls = nullsFirst ? "first" : "last";
                            const child = childQuery(limit, offset, descending, nulls);
                            const compare = (a: Issue, b: Issue) => {
                                let result = 0;
                                if (a.rank === undefined || b.rank === undefined)
                                    result =
                                        a.rank === b.rank
                                            ? 0
                                            : (a.rank === undefined ? -1 : 1) * (nullsFirst ? 1 : -1);
                                else result = (a.rank - b.rank) * (descending ? -1 : 1);
                                return result || a.id.localeCompare(b.id);
                            };
                            const expected = allowed.map((_, i) => ({
                                id: `p${i}`,
                                issues: data
                                    .filter((row) => row.projectId === `p${i}` && row.visible)
                                    .sort(compare)
                                    .slice(offset, offset + limit)
                                    .map(select),
                            }));
                            const query = document(child);
                            expect((await execute(run(query))).value).toEqual({ projects: expected });
                            expect((await execute(run(query, ir, true))).value).toEqual({
                                projects: expected,
                            });
                            const definition: OntologyIR = {
                                ...ir,
                                policy: {
                                    read: {
                                        select: [
                                            q.sub("projects", {
                                                from: { source: { objectType: "Project" }, binding: "p" },
                                                where: q.eq(q.field("p", "allowed"), q.context("allowed")),
                                                select: [
                                                    q.selectField("id", q.field("p", "id")),
                                                    q.sub("issues", child),
                                                ],
                                            }),
                                        ],
                                    },
                                },
                            };
                            const caller: QueryDocument = {
                                select: [
                                    q.sub("issues", {
                                        from: { source: { objectType: "Issue" }, binding: "i" },
                                        select: selections,
                                    }),
                                ],
                            };
                            const visible = expected
                                .flatMap((row, i) => (allowed[i] ? row.issues : []))
                                .sort((a, b) => a.id.localeCompare(b.id));
                            expect((await execute(run(caller, definition, false, true))).value).toEqual({
                                issues: visible,
                            });
                            expect((await execute(run(caller, definition, true, true))).value).toEqual({
                                issues: visible,
                            });
                        }
                    ),
                    { numRuns: 35 }
                )
            );

            const escaped = yield* tables.read((tx) =>
                Effect.succeed(tx.queryGrouped!(children, field("projectId"), { limit: 1 }))
            );
            expect(yield* Effect.result(escaped)).toMatchObject({
                _tag: "Failure",
                failure: { reason: { kind: "Closed" } },
            });
        });
        await Effect.runPromise(
            Effect.scoped(program).pipe(
                Effect.provide(
                    dialect === "sqlite" ? SqliteClient.layer({ filename: ":memory:" }) : PgliteClient.layer()
                )
            )
        );
    },
    60000
);
