import * as q from "@party-stack/ontology-spec/query";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import * as Memory from "../memory/tables.js";
import { Table } from "../model.js";
import { executeQuery } from "./execute.js";
import type { Query } from "../model.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

test("computed table Top K pages candidates and agrees with the full-sort oracle including ties and cursors", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const records = Table.make<Record<string, unknown>>({ name: "scores" });
                yield* tables.transaction((tx) =>
                    Effect.forEach(
                        Array.from({ length: 700 }, (_, id) => id),
                        (id) => tx.put(records, id, { id, age: id % 41, size: id % 19 }),
                        { concurrency: 20 }
                    )
                );
                const ir: OntologyIR = {
                    types: [],
                    objectTypes: [],
                    linkTypes: [],
                    actionTypes: [],
                    queryFunctionTypes: [],
                };
                const scans: Query[] = [];
                const reader = {
                    ir,
                    untypedSources: new Set(["Score"]),
                    loadSubset: (_type: string, scan: Query = {}) => {
                        scans.push(scan);
                        return tables.query(records, scan);
                    },
                };
                const score = q.multiply(q.field("s", "age"), q.add(q.field("s", "size"), q.literal(512)));
                for (const page of [
                    { limit: 7 },
                    { limit: 11, offset: 5 },
                    { limit: 4, after: { values: [2000], key: 20 } },
                    { limit: 0 },
                ]) {
                    const document = {
                        select: [
                            q.sub("scores", {
                                from: { source: { objectType: "Score" }, binding: "s" },
                                where: q.gt(q.field("s", "size"), q.literal(3)),
                                orderBy: [{ expression: score, direction: "desc" as const }],
                                page,
                                select: [q.selectField("id", q.field("s", "id"))],
                            }),
                        ],
                    };
                    scans.length = 0;
                    const planned = yield* executeQuery(document, {
                        reader,
                        error: (failure) => new Error(failure.message),
                    });
                    expect(scans.every((scan) => scan.limit === 256)).toBe(true);
                    const oracle = yield* executeQuery(document, {
                        reader,
                        strategy: "reference",
                        error: (failure) => new Error(failure.message),
                    });
                    expect(planned.value).toEqual(oracle.value);
                }
            })
        )
    );
});
