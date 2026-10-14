import {
    IR,
    Query,
    and,
    createCollection,
    eq,
    gte,
    inArray,
    like,
    localOnlyCollectionOptions,
    not,
    or,
} from "@tanstack/db";
import { afterAll, describe, test } from "vite-plus/test";
import { IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";
import type { LoadSubsetOptions } from "@tanstack/db";
import type { PersistedIndexSpec, PersistedTx } from "@tanstack/db-sqlite-persistence-core";

const ROW_COUNT = 10_000;
const BENCH_OPTIONS = { iterations: 5, time: 1_000, warmupTime: 100, warmupIterations: 5 };

interface BenchItem {
    [key: string]: unknown;
    id: string;
    category: string;
    name: string;
    priority: number;
    status: "closed" | "open" | "pending";
}

const queryItems = createCollection(
    localOnlyCollectionOptions<BenchItem, string>({
        id: "indexeddb-browser-benchmark-query-builder",
        getKey: (item) => item.id,
    })
);

function createBaseQuery() {
    return new Query().from({ item: queryItems });
}

function queryOptions(build: (query: ReturnType<typeof createBaseQuery>) => unknown): LoadSubsetOptions {
    const builder = build(createBaseQuery());
    if (
        typeof builder !== "object" ||
        builder === null ||
        !("_getQuery" in builder) ||
        typeof builder._getQuery !== "function"
    ) {
        throw new TypeError("Expected a TanStack DB query builder.");
    }
    const ir = (builder as { _getQuery(): IR.QueryIR })._getQuery();
    const whereExpressions = (ir.where ?? []).map(IR.getWhereExpression);
    return {
        where:
            whereExpressions.length === 0
                ? undefined
                : whereExpressions.length === 1
                  ? whereExpressions[0]
                  : new IR.Func("and", whereExpressions),
        orderBy: ir.orderBy,
        limit: ir.limit,
        offset: ir.offset,
    };
}

function indexSpec(field: string): PersistedIndexSpec {
    return { expressionSql: [JSON.stringify(new IR.PropRef([field]))] };
}

function buildRows(): BenchItem[] {
    return Array.from({ length: ROW_COUNT }, (_, index) => ({
        id: `item-${index}`,
        category: `category-${index % 100}`,
        name: index % 20 === 0 ? `prefix-${index}` : `item-${index}`,
        priority: index % 1_000,
        status: index % 10 === 0 ? "pending" : index % 2 === 0 ? "open" : "closed",
    }));
}

function seedTransaction(rows: BenchItem[]): PersistedTx {
    return {
        txId: "seed",
        term: 1,
        seq: 1,
        rowVersion: 1,
        mutations: rows.map((value) => ({ type: "insert", key: value.id, value })),
    };
}

const categoryEquals = queryOptions((query) => query.where(({ item }) => eq(item.category, "category-42")));
const highPriority = queryOptions((query) => query.where(({ item }) => gte(item.priority, 900)));
const indexedAnd = queryOptions((query) =>
    query.where(({ item }) => and(eq(item.category, "category-42"), gte(item.priority, 900)))
);
const indexedOr = queryOptions((query) =>
    query.where(({ item }) => or(eq(item.category, "category-42"), gte(item.priority, 900)))
);
const residualAnd = queryOptions((query) =>
    query.where(({ item }) => and(eq(item.category, "category-42"), not(eq(item.status, "open"))))
);
const unplannableOr = queryOptions((query) =>
    query.where(({ item }) => or(eq(item.category, "category-42"), not(eq(item.status, "open"))))
);
const categoryIn = queryOptions((query) =>
    query.where(({ item }) => inArray(item.category, ["category-1", "category-2", "category-3"]))
);
const prefixLike = queryOptions((query) => query.where(({ item }) => like(item.name, "prefix-%")));

const adapter = new IndexedDBPersistenceAdapter({
    databaseName: `runtime-browser-bench-${crypto.randomUUID()}`,
});
await adapter.applyCommittedTx("items", seedTransaction(buildRows()));
await Promise.all([
    adapter.ensureIndex("items", "category-index", indexSpec("category")),
    adapter.ensureIndex("items", "priority-index", indexSpec("priority")),
    adapter.ensureIndex("items", "name-index", indexSpec("name")),
    adapter.ensureIndex("items", "status-index", indexSpec("status")),
]);

const expectedCounts: Array<[string, LoadSubsetOptions, number]> = [
    ["equality", categoryEquals, 100],
    ["range", highPriority, 1_000],
    ["AND", indexedAnd, 10],
    ["OR", indexedOr, 1_090],
    ["residual AND", residualAnd, 100],
    ["unplannable OR", unplannableOr, ROW_COUNT],
    ["IN", categoryIn, 300],
    ["LIKE", prefixLike, 500],
];
for (const [name, options, expected] of expectedCounts) {
    const rows = await adapter.loadSubset("items", options);
    if (rows.length !== expected) {
        throw new Error(`${name} expected ${expected} candidate rows, received ${rows.length}.`);
    }
}

describe("IndexedDBPersistenceAdapter browser query planning", () => {
    test("full collection fallback: 10,000 rows loaded", async ({ bench }) => {
        await bench("full collection fallback: 10,000 rows loaded", async () => {
            await adapter.loadSubset("items", unplannableOr);
        }).run(BENCH_OPTIONS);
    });

    test("equality index: 100 entries scanned / rows loaded", async ({ bench }) => {
        await bench("equality index: 100 entries scanned / rows loaded", async () => {
            await adapter.loadSubset("items", categoryEquals);
        }).run(BENCH_OPTIONS);
    });

    test("range index: 1,000 entries scanned / rows loaded", async ({ bench }) => {
        await bench("range index: 1,000 entries scanned / rows loaded", async () => {
            await adapter.loadSubset("items", highPriority);
        }).run(BENCH_OPTIONS);
    });

    test("indexed AND: 1,100 entries scanned / 10 rows loaded", async ({ bench }) => {
        await bench("indexed AND: 1,100 entries scanned / 10 rows loaded", async () => {
            await adapter.loadSubset("items", indexedAnd);
        }).run(BENCH_OPTIONS);
    });

    test("indexed OR: 1,100 entries scanned / 1,090 rows loaded", async ({ bench }) => {
        await bench("indexed OR: 1,100 entries scanned / 1,090 rows loaded", async () => {
            await adapter.loadSubset("items", indexedOr);
        }).run(BENCH_OPTIONS);
    });

    test("AND with residual NOT: 100 entries scanned / rows loaded", async ({ bench }) => {
        await bench("AND with residual NOT: 100 entries scanned / rows loaded", async () => {
            await adapter.loadSubset("items", residualAnd);
        }).run(BENCH_OPTIONS);
    });

    test("IN with three values: 300 entries scanned / rows loaded", async ({ bench }) => {
        await bench("IN with three values: 300 entries scanned / rows loaded", async () => {
            await adapter.loadSubset("items", categoryIn);
        }).run(BENCH_OPTIONS);
    });

    test("prefix LIKE: 500 entries scanned / rows loaded", async ({ bench }) => {
        await bench("prefix LIKE: 500 entries scanned / rows loaded", async () => {
            await adapter.loadSubset("items", prefixLike);
        }).run(BENCH_OPTIONS);
    });
});

// Persistence analogue of upstream's incremental-update workload: a fixed large
// collection and repeated small edits. These timings include real browser IDB.
const fallbackAdapter = new IndexedDBPersistenceAdapter({
    databaseName: `bench-fallback-${crypto.randomUUID()}`,
});
await fallbackAdapter.applyCommittedTx("items", seedTransaction(buildRows()));
const page = queryOptions((query) => query.orderBy(({ item }) => item.priority, "asc").limit(10));
const emptyAnd = queryOptions((query) =>
    query.where(({ item }) => and(eq(item.category, "absent"), gte(item.priority, 900)))
);
const indexedPage = await adapter.loadSubset("items", page);
const fallbackPage = await fallbackAdapter.loadSubset("items", page);
if (indexedPage.length !== 10 || JSON.stringify(indexedPage) !== JSON.stringify(fallbackPage))
    throw new Error("Pagination benchmark paths disagree");
let writeVersion = 1;
describe("IndexedDB persistence pagination and incremental updates", () => {
    test("ordered index: first 10 of 10,000 rows", async ({ bench }) => {
        await bench("ordered index: first 10 of 10,000 rows", async () => {
            await adapter.loadSubset("items", page);
        }).run(BENCH_OPTIONS);
    });
    test("unindexed fallback: same first 10 of 10,000 rows", async ({ bench }) => {
        await bench("unindexed fallback: same first 10 of 10,000 rows", async () => {
            await fallbackAdapter.loadSubset("items", page);
        }).run(BENCH_OPTIONS);
    });
    test("empty AND: absent category intersected with 1,000 priorities", async ({ bench }) => {
        await bench("empty AND: absent category intersected with 1,000 priorities", async () => {
            if ((await adapter.loadSubset("items", emptyAnd)).length !== 0)
                throw new Error("Empty intersection returned rows");
        }).run(BENCH_OPTIONS);
    });
    test("one-row partial update with four maintained indexes", async ({ bench }) => {
        await bench("one-row partial update with four maintained indexes", async () => {
            const version = ++writeVersion;
            await adapter.applyCommittedTx("items", {
                txId: `update-${version}`,
                term: 1,
                seq: version,
                rowVersion: version,
                mutations: [{ type: "update", key: "item-0", value: { priority: version % 1000 } }],
            });
        }).run(BENCH_OPTIONS);
    });
});

afterAll(() => {
    adapter.close();
    fallbackAdapter.close();
});
