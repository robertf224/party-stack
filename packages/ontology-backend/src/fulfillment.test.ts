import { it } from "@effect/vitest";
import { o } from "@party-stack/ontology-spec";
import { and, eq, field, inArray, evaluateQuery } from "@party-stack/ontology-storage";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { resolveSubsetSnapshot, coversSubset } from "./fulfillment.js";
import { objectSubset } from "./subset.js";
import type { BackendSnapshot } from "./index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Query } from "@party-stack/ontology-storage";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Issue",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "status", displayName: "Status", type: o.string({}) },
                { name: "rank", displayName: "Rank", type: o.integer({}) },
            ],
        },
    ],
};
const rows = Array.from({ length: 30 }, (_, index) => ({
    key: `issue-${index}`,
    value: { id: `issue-${index}`, status: index % 2 ? "Open" : "Done", rank: index },
}));
const resolve = (query: Query, snapshot: BackendSnapshot) =>
    Effect.runPromise(resolveSubsetSnapshot(ir, objectSubset("Issue", query), snapshot));

test("an omitted fulfilled subset preserves an already-applied offset", async () => {
    const query: Query = { orderBy: [{ field: field("rank"), direction: "asc" }], offset: 10, limit: 5 };
    const expected = evaluateQuery(rows, query);
    expect((await resolve(query, { rows: expected, complete: true })).snapshot.rows).toEqual(expected);
});

test("an explicit complete collection supplies filtering, sorting and pagination", async () => {
    const query: Query = {
        where: eq(field("status"), "Open"),
        orderBy: [{ field: field("rank"), direction: "desc" }],
        offset: 2,
        limit: 3,
    };
    expect(
        (await resolve(query, { rows, complete: true, fulfilledSubset: objectSubset("Issue") })).snapshot.rows
    ).toEqual(evaluateQuery(rows, query));
});

test("a wider provider window skips only the still-unapplied offset", async () => {
    const orderBy = [{ field: field("rank"), direction: "asc" as const }];
    const actual = { orderBy, offset: 5, limit: 15 };
    const query = { orderBy, offset: 10, limit: 4 };
    const result = await resolve(query, {
        rows: evaluateQuery(rows, actual),
        complete: true,
        fulfilledSubset: objectSubset("Issue", actual),
    });
    expect(result.snapshot.rows).toEqual(evaluateQuery(rows, query));
});

test("bounded/filtered declarations cannot falsely certify a different request", async () => {
    for (const actual of [{ limit: 3 }, { where: eq(field("status"), "Done") }, { offset: 2, limit: 10 }]) {
        const result = await Effect.runPromise(
            Effect.result(
                resolveSubsetSnapshot(ir, objectSubset("Issue", { limit: 5 }), {
                    rows: evaluateQuery(rows, actual),
                    complete: true,
                    fulfilledSubset: objectSubset("Issue", actual),
                })
            )
        );
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { kind: "InvalidResponse", retryable: false },
        });
    }
});

test("field IN coverage contains a narrower key equality/conjunction", () => {
    expect(
        coversSubset(
            {
                objectType: "Issue",
                query: { where: and(eq(field("id"), "one"), eq(field("status"), "Open")) },
            },
            { objectType: "Issue", query: { where: inArray(field("id"), ["one", "two"]) } }
        )
    ).toBe(true);
});

it.live.prop(
    "generated projections of broader snapshots agree with a full-scan oracle",
    [
        Schema.Array(
            Schema.Struct({
                status: Schema.Literals(["Open", "Done"]),
                rank: Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 5 })),
            })
        ).check(Schema.isMaxLength(60)),
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
    ],
    ([values, offset, limit]) =>
        Effect.gen(function* () {
            const input = values.map((value, index) => ({
                key: `i${index}`,
                value: { id: `i${index}`, ...value },
            }));
            const orderBy = [{ field: field("rank"), direction: "desc" as const }];
            const query = { where: eq(field("status"), "Open"), orderBy, offset, limit };
            const sorted = input
                .filter((row) => row.value.status === "Open")
                .sort((a, b) => b.value.rank - a.value.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            const expected = sorted.slice(offset, offset + limit);
            for (const actual of [{}, { where: eq(field("status"), "Open") }])
                expect(
                    (yield* Effect.promise(() =>
                        resolve(query, {
                            rows: evaluateQuery(input, actual),
                            complete: true,
                            fulfilledSubset: objectSubset("Issue", actual),
                        })
                    )).snapshot.rows
                ).toEqual(expected);
        }),
    { arbitrary: { runs: 100 } }
);
