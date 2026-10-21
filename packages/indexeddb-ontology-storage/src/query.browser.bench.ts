import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import {
    Table,
    and,
    applyQuery,
    eq,
    field,
    gte,
    ilike,
    inArray,
    like,
    or,
    type Query,
    type TablesService,
} from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Scope } from "effect";
import { afterAll, beforeAll, describe, test } from "vite-plus/test";
import { make } from "./tables.js";

const COUNT = 10_000;
const options = { iterations: 5, time: 300, warmupTime: 50, warmupIterations: 2 };
const scope = Scope.makeUnsafe();
const table = Table.make<{ n: number; category: number; name: string }>({ name: "items" });
const all = Array.from({ length: COUNT }, (_, i) => ({
    key: `item-${String(i).padStart(5, "0")}`,
    value: { n: i % 1000, category: i % 100, name: `Prefix-${i}` },
}));
let tables: TablesService;
let memory: TablesService;
const cases: [string, Query][] = [
    ["equality / 100 matches", { where: eq(field("category"), 42) }],
    ["selective AND / 10 matches", { where: and(gte(field("n"), 900), eq(field("category"), 42)) }],
    ["empty AND", { where: and(gte(field("n"), 900), eq(field("category"), -1)) }],
    ["OR / 1090 matches", { where: or(gte(field("n"), 900), eq(field("category"), 42)) }],
    ["IN / 300 matches", { where: inArray(field("category"), [1, 2, 3]) }],
    ["LIKE / 111 candidates", { where: like(field("name"), "Prefix-99_"), limit: 10 }],
    ["ILIKE / 111 matches", { where: ilike(field("name"), "pREFIX-99%") }],
    [
        "ascending page / 10 rows",
        { where: gte(field("n"), 900), orderBy: [{ field: field("n") }], limit: 10 },
    ],
    ["descending page / tied keys", { orderBy: [{ field: field("n"), direction: "desc" }], limit: 10 }],
];
const scanTable = Table.make<{ n: number; category: number; name: string }>({ name: "unindexed" });
beforeAll(async () => {
    tables = await Effect.runPromise(
        make({ databaseName: `tables-bench-${crypto.randomUUID()}` }).pipe(
            Scope.provide(scope),
            Effect.provideService(IndexedDb.IndexedDb, IndexedDb.make({ indexedDB, IDBKeyRange }))
        )
    );
    await Effect.runPromise(
        tables.withTransaction(
            Effect.gen(function* () {
                for (const row of all) {
                    yield* tables.put(table, row.key, row.value);
                    yield* tables.put(scanTable, row.key, row.value);
                }
                for (const name of ["n", "category", "name"])
                    yield* tables.ensureIndex(table, { name, field: field(name) });
            })
        )
    );
    memory = await Effect.runPromise(Memory.make());
    await Effect.runPromise(
        memory.withTransaction(
            Effect.gen(function* () {
                for (const row of all) yield* memory.put(table, row.key, row.value);
                for (const name of ["n", "category", "name"])
                    yield* memory.ensureIndex(table, { name, field: field(name) });
            })
        )
    );
    for (const [, query] of cases) {
        const expected = applyQuery(all, query).map((r) => r.key);
        const actual = (await Effect.runPromise(tables.loadSubset(table, query))).map((r) => r.key);
        const ephemeral = (await Effect.runPromise(memory.loadSubset(table, query))).map((r) => r.key);
        if (!query.orderBy?.length) {
            ephemeral.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            actual.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            expected.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        }
        if (
            JSON.stringify(ephemeral) !== JSON.stringify(expected) ||
            JSON.stringify(actual) !== JSON.stringify(expected)
        )
            throw new Error(`Benchmark queries disagree: ${JSON.stringify(query)}`);
    }
}, 120000);
describe.each(cases)("%s", (_name, query) => {
    test("memory indexed", async ({ bench }) => {
        await bench("memory indexed", () => Effect.runPromise(memory.loadSubset(table, query))).run(options);
    });
    test("tables indexed", async ({ bench }) => {
        await bench("tables indexed", () => Effect.runPromise(tables.loadSubset(table, query))).run(options);
    });
    test("tables full scan", async ({ bench }) => {
        await bench("tables full scan", () => Effect.runPromise(tables.loadSubset(scanTable, query))).run(
            options
        );
    });
});
afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
});
