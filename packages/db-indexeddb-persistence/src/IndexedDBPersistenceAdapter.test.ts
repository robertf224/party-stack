import "fake-indexeddb/auto";
import {
    BTreeIndex,
    IR,
    Query,
    and,
    createCollection,
    createLiveQueryCollection,
    eq,
    gt,
    ilike,
    inArray,
    isNull,
    isUndefined,
    like,
    localOnlyCollectionOptions,
    lower,
    not,
    or,
} from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { openDB } from "idb";
import { Temporal } from "temporal-polyfill";
import { afterAll, describe, expect, it, vi } from "vitest";
import { IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";
import type { LoadSubsetOptions } from "@tanstack/db";
import type { PersistedIndexSpec, PersistedTx } from "@tanstack/db-sqlite-persistence-core";

interface Item {
    [key: string]: unknown;
    id: string;
    mixed?: unknown;
    name?: string;
    nullable?: string | null;
    date?: Temporal.PlainDate;
    instant?: Temporal.Instant;
    status?: string;
    priority: number;
}

const queryItems = createCollection(
    localOnlyCollectionOptions<Item, string>({
        id: "indexeddb-persistence-query-builder",
        getKey: (item) => item.id,
    })
);

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

function createBaseQuery() {
    return new Query().from({ item: queryItems });
}

afterAll(async () => {
    await queryItems.cleanup();
});

function databaseName(): string {
    return `runtime-${crypto.randomUUID()}`;
}

function tx(
    txId: string,
    rowVersion: number,
    mutations: PersistedTx<Item, string>["mutations"]
): PersistedTx<Item, string> {
    return {
        txId,
        term: 1,
        seq: rowVersion,
        rowVersion,
        mutations,
    };
}

function indexSpec(path: string[]): PersistedIndexSpec {
    return expressionIndexSpec(new IR.PropRef(path));
}

function expressionIndexSpec(expression: IR.BasicExpression): PersistedIndexSpec {
    return {
        expressionSql: [JSON.stringify(expression)],
    };
}

async function seed(adapter: IndexedDBPersistenceAdapter, items: Item[]): Promise<void> {
    await adapter.applyCommittedTx(
        "items",
        tx(
            "seed",
            1,
            items.map((value) => ({
                type: "insert",
                key: value.id,
                value,
            }))
        )
    );
}

function ids(rows: Array<{ value: Record<string, unknown> }>): string[] {
    return rows.map((row) => String(row.value.id)).sort();
}

describe("IndexedDBPersistenceAdapter", () => {
    it.each([false, true])("preserves bigint queries and numeric pagination (indexed=%s)", async (indexed) => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
        const values = [-9_223_372_036_854_775_808n, -10n, -2n, 0n, 2n, 10n, 9_223_372_036_854_775_807n];
        try {
            await seed(adapter, values.map((mixed, priority) => ({ id: String(priority), priority, mixed })));
            if (indexed) await adapter.ensureIndex("items", "bigint", indexSpec(["mixed"]));
            expect(ids(await adapter.loadSubset("items", queryOptions(
                (query) => query.where(({ item }) => eq(item.mixed, 10n)).limit(100)
            )))).toEqual(["5"]);
            expect(ids(await adapter.loadSubset("items", queryOptions(
                (query) => query.where(({ item }) => gt(item.mixed, 2n)).limit(100)
            )))).toEqual(["5", "6"]);
            expect((await adapter.loadSubset("items", queryOptions((query) => query.orderBy(({ item }) => item.mixed, "asc").offset(1).limit(3)))).map((row) => row.value.mixed)).toEqual([-10n, -2n, 0n]);
            expect((await adapter.loadSubset("items", queryOptions((query) => query.orderBy(({ item }) => item.mixed, "desc").limit(3)))).map((row) => row.value.mixed)).toEqual([values[6], 10n, 2n]);
        } finally {
            adapter.close();
        }
        const reopened = new IndexedDBPersistenceAdapter({ databaseName: name });
        try {
            expect((await reopened.loadResumeSnapshot("items")).rows.map((row) => row.value.mixed)).toEqual(values);
        } finally {
            reopened.close();
        }
    });

    it("uses ordered bigint indexes across signs, digit lengths, and arbitrary precision", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        const values = [
            -(10n ** 100n), -(2n ** 63n) - 1n, -1001n, -1000n, -999n, -101n, -100n, -99n,
            -11n, -10n, -9n, -2n, -1n, 0n, 1n, 2n, 9n, 10n, 11n, 99n, 100n, 101n,
            999n, 1000n, 1001n, 2n ** 63n, 10n ** 100n,
        ];
        try {
            await seed(adapter, values.map((mixed, priority) => ({ id: String(priority).padStart(2, "0"), priority, mixed })));
            await adapter.ensureIndex("items", "bigint", indexSpec(["mixed"]));
            for (const threshold of [-1000n, -10n, -1n, 0n, 1n, 10n, 1000n, 10n ** 100n]) {
                for (const operator of ["eq", "gt", "gte", "lt", "lte"] as const) {
                    const matches = (value: bigint) => operator === "eq" ? value === threshold :
                        operator === "gt" ? value > threshold : operator === "gte" ? value >= threshold :
                        operator === "lt" ? value < threshold : value <= threshold;
                    const rows = await adapter.loadSubset("items", {
                        where: new IR.Func<boolean>(operator, [new IR.PropRef(["mixed"]), new IR.Value(threshold)]),
                    });
                    expect(rows.map((row) => row.value.mixed).sort((a, b) => (a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0), `${operator} ${threshold}`).toEqual(values.filter(matches));
                }
            }
            const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
            const get = vi.spyOn(IDBObjectStore.prototype, "get");
            try {
                for (const direction of ["asc", "desc"] as const) {
                    get.mockClear();
                    const rows = await adapter.loadSubset("items", queryOptions((query) =>
                        query.orderBy(({ item }) => item.mixed, direction).offset(2).limit(3)
                    ));
                    expect(rows.map((row) => row.value.mixed)).toEqual((direction === "asc" ? values : [...values].reverse()).slice(2, 5));
                    expect(get.mock.contexts.filter((store) => (store as IDBObjectStore).name === "rows")).toHaveLength(5);
                }
                get.mockClear();
                const rows = await adapter.loadSubset("items", queryOptions((query) =>
                    query.where(({ item }) => gt(item.mixed, 9n)).orderBy(({ item }) => item.mixed, "asc").limit(2)
                ));
                expect(rows.map((row) => row.value.mixed)).toEqual([10n, 11n]);
                expect(get.mock.contexts.filter((store) => (store as IDBObjectStore).name === "rows")).toHaveLength(2);
                expect(getAll.mock.contexts.some((index) => (index as IDBIndex).objectStore.name === "rows")).toBe(false);
            } finally {
                getAll.mockRestore();
                get.mockRestore();
            }
        } finally {
            adapter.close();
        }
    });

    it("keeps bigint cursor ties and filters before counting pagination offsets", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        try {
            await seed(adapter, [
                { id: "z", priority: 0, mixed: -10n, status: "open" },
                { id: "a", priority: 1, mixed: -10n, status: "open" },
                { id: "excluded", priority: 2, mixed: -1n, status: "closed" },
                { id: "b", priority: 3, mixed: 0n, status: "open" },
                { id: "c", priority: 4, mixed: 10n, status: "open" },
            ]);
            await adapter.ensureIndex("items", "bigint", indexSpec(["mixed"]));
            expect((await adapter.loadSubset("items", queryOptions((query) =>
                query.where(({ item }) => eq(item.status, "open")).orderBy(({ item }) => item.mixed, "asc").offset(1).limit(2)
            ))).map((row) => row.key)).toEqual(["z", "b"]);
            expect((await adapter.loadSubset("items", queryOptions((query) =>
                query.orderBy(({ item }) => item.mixed, "desc").offset(3).limit(1)
            ))).map((row) => row.key)).toEqual(["a"]);
            const orderBy = queryOptions((query) => query.orderBy(({ item }) => item.mixed, "asc")).orderBy;
            const rows = await adapter.loadSubset("items", {
                orderBy, limit: 1,
                cursor: {
                    whereCurrent: new IR.Func<boolean>("eq", [new IR.PropRef(["mixed"]), new IR.Value(-10n)]),
                    whereFrom: new IR.Func<boolean>("gt", [new IR.PropRef(["mixed"]), new IR.Value(-10n)]),
                },
            });
            expect(rows.map((row) => row.key)).toEqual(["a", "z", "excluded"]);
        } finally {
            adapter.close();
        }
    });

    it.each(["ensureIndex", "write"])("rebuilds version 2 bigint indexes once through %s", async (trigger) => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
        try {
            await seed(adapter, [{ id: "negative", priority: 1, mixed: -10n }, { id: "positive", priority: 2, mixed: 2n }]);
            await adapter.ensureIndex("items", "bigint", indexSpec(["mixed"]));
            const database = await openDB(name);
            const definition = await database.get("indexDefinitions", ["items", "bigint"]) as Record<string, unknown>;
            await database.put("indexDefinitions", { ...definition, encodingVersion: 2 });
            const entries = await database.getAllFromIndex("indexEntries", "index", ["items", "bigint"]) as Array<Record<string, unknown>>;
            for (const entry of entries) {
                const row = await database.get("rows", entry.rowId as string) as { value: { mixed: bigint } };
                await database.put("indexEntries", { ...entry, value: row.value.mixed.toString() });
            }
            database.close();
            const page = queryOptions((query) => query.orderBy(({ item }) => item.mixed, "asc").limit(1));
            expect((await adapter.loadSubset("items", page)).map((row) => row.key)).toEqual(["negative"]);
            expect((await adapter.loadSubset("items", queryOptions((query) => query.where(({ item }) => gt(item.mixed, 0n)).limit(1)))).map((row) => row.key)).toEqual(["positive"]);
            const put = vi.spyOn(IDBObjectStore.prototype, "put");
            try {
                if (trigger === "ensureIndex") await adapter.ensureIndex("items", "bigint", indexSpec(["mixed"]));
                else await adapter.applyCommittedTx("items", tx("change", 2, [{ type: "update", key: "positive", value: { id: "positive", priority: 2, mixed: 20n } }]));
                expect(put.mock.contexts.filter((store) => (store as IDBObjectStore).name === "indexEntries")).toHaveLength(2);
                put.mockClear();
                await adapter.ensureIndex("items", "bigint", indexSpec(["mixed"]));
                expect(put).not.toHaveBeenCalled();
            } finally {
                put.mockRestore();
            }
            expect((await adapter.loadSubset("items", queryOptions((query) => query.where(({ item }) => gt(item.mixed, 0n))))).map((row) => row.key)).toEqual(["positive"]);
        } finally {
            adapter.close();
        }
    });

    it("reuses version 2 non-bigint indexes and promotes incremental writes to version 3", async () => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
        try {
            await seed(adapter, [{ id: "one", priority: 1, mixed: 1 }]);
            await adapter.ensureIndex("items", "mixed", indexSpec(["mixed"]));
            const database = await openDB(name);
            const definition = await database.get("indexDefinitions", ["items", "mixed"]) as Record<string, unknown>;
            await database.put("indexDefinitions", { ...definition, encodingVersion: 2 });
            database.close();
            const put = vi.spyOn(IDBObjectStore.prototype, "put");
            const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
            try {
                await adapter.ensureIndex("items", "mixed", indexSpec(["mixed"]));
                expect(put).not.toHaveBeenCalled();
                await adapter.applyCommittedTx("items", tx("bigint", 2, [{ type: "update", key: "one", value: { id: "one", priority: 1, mixed: 10n } }]));
                expect(getAll.mock.contexts.some((index) => (index as IDBIndex).objectStore.name === "rows")).toBe(false);
                put.mockClear();
                await adapter.ensureIndex("items", "mixed", indexSpec(["mixed"]));
                expect(put).not.toHaveBeenCalled();
                expect((await adapter.loadSubset("items", queryOptions((query) => query.orderBy(({ item }) => item.mixed, "asc").limit(1)))).map((row) => row.value.mixed)).toEqual([10n]);
            } finally {
                put.mockRestore();
                getAll.mockRestore();
            }
        } finally {
            adapter.close();
        }
    });

    it("preserves native values and nested Temporal containers through storage, metadata, and replay", async () => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
        const instant = Temporal.Instant.from("2026-10-07T12:00:00.123456789Z");
        const date = Temporal.PlainDate.from("2026-10-07");
        const collision = { __party_stack_runtime_persisted_type__: "Temporal.Instant", value: "ordinary data" };
        const cycle: Record<string, unknown> = { instant };
        cycle.self = cycle;
        const payload = {
            bigint: 2n ** 100n, date: new Date("2026-10-07T00:00:00Z"),
            nan: NaN, infinity: Infinity, negativeInfinity: -Infinity, undefined,
            map: new Map([[instant, new Set([date])]]), collision, cycle,
        };
        try {
            await adapter.applyCommittedTx("items", {
                ...tx("values", 1, [{ type: "insert", key: "one", value: { id: "one", priority: 1, mixed: payload }, metadata: payload, metadataChanged: true }]),
                collectionMetadataMutations: [{ type: "set", key: "values", value: payload }],
            });
        } finally {
            adapter.close();
        }
        const reopened = new IndexedDBPersistenceAdapter({ databaseName: name });
        const check = (value: unknown) => {
            const restored = value as typeof payload;
            for (const key of ["bigint", "date", "nan", "infinity", "negativeInfinity", "undefined", "collision"] as const) expect(restored[key]).toEqual(payload[key]);
            const [key, entries] = [...restored.map.entries()][0]!;
            expect(key).toBeInstanceOf(Temporal.Instant);
            expect(key.epochNanoseconds).toBe(instant.epochNanoseconds);
            const restoredDate = [...entries][0]!;
            expect(restoredDate).toBeInstanceOf(Temporal.PlainDate);
            expect(restoredDate.toString()).toBe(date.toString());
            expect(restored.cycle.self).toBe(restored.cycle);
            expect(restored.cycle.instant).toBeInstanceOf(Temporal.Instant);
        };
        try {
            const snapshot = await reopened.loadResumeSnapshot("items");
            check(snapshot.rows[0]?.value.mixed);
            check(snapshot.rows[0]?.metadata);
            check(snapshot.collectionMetadata[0]?.value);
            const replay = await reopened.pullSince("items", 0);
            expect(replay.requiresFullReload).toBe(false);
            if (!replay.requiresFullReload) {
                check(replay.deltas?.[0]?.changedRows[0]?.value.mixed);
                const metadata = replay.deltas?.[0]?.rowMetadataMutations[0];
                check(metadata?.type === "set" ? metadata.value : undefined);
                const collectionMetadata = replay.deltas?.[0]?.collectionMetadataMutations[0];
                check(collectionMetadata?.type === "set" ? collectionMetadata.value : undefined);
            }
        } finally {
            reopened.close();
        }
    });

    it("rejects unsupported Temporal kinds atomically instead of silently storing empty objects", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        try {
            await expect(seed(adapter, [{ id: "one", priority: 1, mixed: Temporal.PlainDateTime.from("2026-10-07T12:00:00") }])).rejects.toThrow("Unsupported Temporal.PlainDateTime");
            expect((await adapter.loadResumeSnapshot("items")).rows).toEqual([]);
            expect((await adapter.loadResumeSnapshot("items")).latestRowVersion).toBe(0);
        } finally {
            adapter.close();
        }
    });

    it("rebuilds legacy index encodings once and avoids using them before migration", async () => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
        await seed(adapter, [{ id: "one", priority: 1, status: "open" }]);
        await adapter.ensureIndex("items", "status", indexSpec(["status"]));
        const database = await openDB(name);
        const legacy = (await database.get("indexDefinitions", ["items", "status"])) as {
            valueTypeCounts?: unknown;
            unsupportedValueCount?: unknown;
            encodingVersion?: unknown;
        };
        delete legacy.valueTypeCounts;
        delete legacy.unsupportedValueCount;
        delete legacy.encodingVersion;
        await database.put("indexDefinitions", legacy);
        database.close();
        expect(
            ids(
                await adapter.loadSubset(
                    "items",
                    queryOptions((query) => query.where(({ item }) => eq(item.status, "missing")))
                )
            )
        ).toEqual(["one"]);
        const put = vi.spyOn(IDBObjectStore.prototype, "put");
        try {
            await adapter.ensureIndex("items", "status", indexSpec(["status"]));
            expect(
                put.mock.contexts.filter((store) => (store as IDBObjectStore).name === "indexEntries")
            ).toHaveLength(2);
            put.mockClear();
            await adapter.ensureIndex("items", "status", indexSpec(["status"]));
            expect(put).not.toHaveBeenCalled();
            expect(
                await adapter.loadSubset(
                    "items",
                    queryOptions((query) => query.where(({ item }) => eq(item.status, "missing")))
                )
            ).toEqual([]);
        } finally {
            put.mockRestore();
            adapter.close();
        }
    });

    it("rolls back row writes when index maintenance fails", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(adapter, [{ id: "one", priority: 1 }]);
        await adapter.ensureIndex("items", "priority", indexSpec(["priority"]));
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to the actual store with call below.
        const originalPut = IDBObjectStore.prototype.put;
        const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
            this: IDBObjectStore,
            value,
            key
        ) {
            if (this.name === "indexEntries") throw new Error("Index write failed");
            return originalPut.call(this, value, key);
        });
        try {
            await expect(
                adapter.applyCommittedTx(
                    "items",
                    tx("failed", 2, [{ type: "update", key: "one", value: { id: "one", priority: 2 } }])
                )
            ).rejects.toThrow("Index write failed");
        } finally {
            put.mockRestore();
        }
        try {
            expect((await adapter.loadResumeSnapshot("items")).latestRowVersion).toBe(1);
            expect(
                await adapter.loadSubset(
                    "items",
                    queryOptions((query) => query.where(({ item }) => eq(item.priority, 1)))
                )
            ).toMatchObject([{ key: "one", value: { priority: 1 } }]);
        } finally {
            adapter.close();
        }
    });

    it("updates only touched rows and index entries, and reuses an existing index", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(
            adapter,
            Array.from({ length: 50 }, (_, priority) => ({ id: String(priority), priority, status: "open" }))
        );
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        const put = vi.spyOn(IDBObjectStore.prototype, "put");
        const remove = vi.spyOn(IDBObjectStore.prototype, "delete");
        const scan = vi.spyOn(IDBIndex.prototype, "getAll");
        try {
            await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
            expect(put).not.toHaveBeenCalled();
            expect(remove).not.toHaveBeenCalled();
            expect(scan).not.toHaveBeenCalled();
            await adapter.applyCommittedTx(
                "items",
                tx("edit", 2, [
                    { type: "update", key: "0", value: { id: "0", priority: 0, status: "closed" } },
                ])
            );
            expect(
                put.mock.contexts.filter((store) => (store as IDBObjectStore).name === "rows")
            ).toHaveLength(1);
            expect(
                put.mock.contexts.filter((store) => (store as IDBObjectStore).name === "indexEntries")
            ).toHaveLength(2);
            expect(
                remove.mock.contexts.filter((store) => (store as IDBObjectStore).name === "rows")
            ).toHaveLength(0);
            expect(
                remove.mock.contexts.filter((store) => (store as IDBObjectStore).name === "indexEntries")
            ).toHaveLength(2);
            expect(scan.mock.contexts.some((index) => (index as IDBIndex).objectStore.name === "rows")).toBe(
                false
            );
            put.mockClear();
            remove.mockClear();
            scan.mockClear();
            await adapter.applyCommittedTx("items", {
                ...tx("metadata", 3, []),
                collectionMetadataMutations: [{ type: "set", key: "cursor", value: "next" }],
            });
            expect(put.mock.contexts.map((store) => (store as IDBObjectStore).name)).not.toContain("rows");
            expect(put.mock.contexts.map((store) => (store as IDBObjectStore).name)).not.toContain(
                "indexEntries"
            );
            expect(remove).not.toHaveBeenCalled();
        } finally {
            put.mockRestore();
            remove.mockRestore();
            scan.mockRestore();
            adapter.close();
        }
    });

    it("restores indexed range filtering when the last mixed or unsupported value is removed", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        try {
            await seed(adapter, [
                { id: "one", priority: 1, mixed: 1 },
                { id: "two", priority: 2, mixed: 2 },
                { id: "string", priority: 0, mixed: "text" },
                { id: "object", priority: 0, mixed: {} },
            ]);
            await adapter.ensureIndex("items", "mixed", indexSpec(["mixed"]));
            await adapter.applyCommittedTx(
                "items",
                tx("remove-mixed", 2, [
                    { type: "delete", key: "string", value: { id: "string", priority: 0 } },
                    { type: "delete", key: "object", value: { id: "object", priority: 0 } },
                ])
            );
            expect(
                ids(
                    await adapter.loadSubset(
                        "items",
                        queryOptions((query) => query.where(({ item }) => gt(item.mixed, 1)))
                    )
                )
            ).toEqual(["two"]);
            await adapter.applyCommittedTx("items", { ...tx("reset", 3, []), truncate: true });
            await adapter.applyCommittedTx(
                "items",
                tx("reseed", 4, [{ type: "insert", key: "new", value: { id: "new", priority: 3, mixed: 3 } }])
            );
            expect(
                ids(
                    await adapter.loadSubset(
                        "items",
                        queryOptions((query) => query.where(({ item }) => gt(item.mixed, 1)))
                    )
                )
            ).toEqual(["new"]);
        } finally {
            adapter.close();
        }
    });

    it("keeps indexed Instant ranges accurate within one millisecond", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        try {
            const instant = Temporal.Instant.from("2026-10-05T12:00:00.000000001Z");
            await seed(adapter, [
                { id: "early", priority: 1, instant },
                { id: "later", priority: 2, instant: instant.add({ nanoseconds: 1 }) },
            ]);
            await adapter.ensureIndex("items", "instant", indexSpec(["instant"]));
            expect(
                ids(
                    await adapter.loadSubset(
                        "items",
                        queryOptions((query) => query.where(({ item }) => gt(item.instant, instant)))
                    )
                )
            ).toEqual(["later"]);
        } finally {
            adapter.close();
        }
    });

    it("orders indexed PlainDate ranges across negative and extended years", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        try {
            const date = Temporal.PlainDate.from("-000002-01-01");
            await seed(adapter, [
                { id: "earlier", priority: 1, date: Temporal.PlainDate.from("-000003-01-01") },
                { id: "later", priority: 2, date: Temporal.PlainDate.from("-000001-01-01") },
                { id: "future", priority: 3, date: Temporal.PlainDate.from("+010000-01-01") },
            ]);
            await adapter.ensureIndex("items", "date", indexSpec(["date"]));
            expect(
                ids(
                    await adapter.loadSubset(
                        "items",
                        queryOptions((query) => query.where(({ item }) => gt(item.date, date)))
                    )
                )
            ).toEqual(["future", "later"]);
        } finally {
            adapter.close();
        }
    });

    it("restores rows, metadata, and stream position from one resume snapshot", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        const instant = Temporal.Instant.from("2026-10-05T12:00:00Z");
        try {
            await adapter.applyCommittedTx("items", {
                ...tx("snapshot", 7, [
                    { type: "insert", key: "one", value: { id: "one", priority: 1, instant } },
                ]),
                collectionMetadataMutations: [{ type: "set", key: "cursor", value: instant }],
            });
            const snapshot = await adapter.loadResumeSnapshot("items");
            expect(snapshot).toMatchObject({
                rows: [{ key: "one", value: { id: "one", priority: 1, instant } }],
                collectionMetadata: [{ key: "cursor", value: instant }],
                latestTerm: 1,
                latestSeq: 7,
                latestRowVersion: 7,
                resetEpoch: 0,
            });
            expect(await adapter.loadResumeSnapshot("items", { includeRows: false })).toEqual({
                ...snapshot,
                rows: [],
            });
            expect(await adapter.loadResumeSnapshot("missing")).toEqual({
                rows: [],
                collectionMetadata: [],
                latestTerm: 0,
                latestSeq: 0,
                latestRowVersion: 0,
                resetEpoch: 0,
            });
        } finally {
            adapter.close();
        }
    });

    it("makes a second ordered persisted query ready synchronously without rereading storage", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(adapter, [
            { id: "three", priority: 3 },
            { id: "one", priority: 1 },
            { id: "two", priority: 2 },
        ]);
        const loadSubset = vi.spyOn(adapter, "loadSubset");
        const items = createCollection(
            persistedCollectionOptions<Item, string>({
                id: "items",
                getKey: (item) => item.id,
                syncMode: "on-demand",
                persistence: { adapter },
                sync: {
                    sync: ({ markReady }) => {
                        markReady();
                        return { loadSubset: () => true };
                    },
                },
            })
        );
        items.createIndex((item) => item.priority, { indexType: BTreeIndex });
        const createWindow = () =>
            createLiveQueryCollection({
                query: (q) =>
                    q
                        .from({ item: items })
                        .orderBy(({ item }) => item.priority, "asc")
                        .limit(2),
                startSync: true,
                gcTime: 0,
            });
        const first = createWindow();
        let second: ReturnType<typeof createWindow> | undefined;
        try {
            await first.preload();
            expect([...first.values()].map((item) => item.id)).toEqual(["one", "two"]);
            const reads = loadSubset.mock.calls.length;
            second = createWindow();
            expect(second.status).toBe("ready");
            expect([...second.values()].map((item) => item.id)).toEqual(["one", "two"]);
            expect(loadSubset).toHaveBeenCalledTimes(reads);
        } finally {
            await second?.cleanup();
            await first.cleanup();
            await items.cleanup();
            adapter.close();
        }
    });

    it("persists a local-only TanStack DB collection across instances", async () => {
        const name = databaseName();
        const firstAdapter = new IndexedDBPersistenceAdapter({
            databaseName: name,
        });
        const createItems = (adapter: IndexedDBPersistenceAdapter) =>
            createCollection(
                persistedCollectionOptions<Item, string>({
                    id: "items",
                    getKey: (item) => item.id,
                    persistence: { adapter },
                })
            );

        const first = createItems(firstAdapter);
        await first.preload();
        const transaction = first.insert({
            id: "one",
            status: "open",
            priority: 1,
        });
        await transaction.isPersisted.promise;
        await first.cleanup();
        firstAdapter.close();

        const secondAdapter = new IndexedDBPersistenceAdapter({
            databaseName: name,
        });
        const second = createItems(secondAdapter);
        await second.preload();
        expect(second.get("one")).toMatchObject({
            status: "open",
            priority: 1,
        });
        await second.cleanup();
        secondAdapter.close();
    });

    it("deletes a reloaded row after a non-optimistic update", async () => {
        const name = databaseName();
        const createItems = (adapter: IndexedDBPersistenceAdapter) =>
            createCollection(
                persistedCollectionOptions<Item, string>({
                    id: "outbox-items",
                    getKey: (item) => item.id,
                    persistence: { adapter },
                })
            );
        const firstAdapter = new IndexedDBPersistenceAdapter({
            databaseName: name,
        });
        const first = createItems(firstAdapter);
        await first.preload();
        await first.insert(
            {
                id: "one",
                status: "executing",
                priority: 1,
            },
            { optimistic: false }
        ).isPersisted.promise;
        await first.cleanup();
        firstAdapter.close();

        const secondAdapter = new IndexedDBPersistenceAdapter({
            databaseName: name,
        });
        const second = createItems(secondAdapter);
        await second.preload();
        await second.update("one", { optimistic: false }, (draft) => {
            draft.status = "failed";
        }).isPersisted.promise;

        expect(second.has("one")).toBe(true);
        await second.delete("one", {
            optimistic: false,
        }).isPersisted.promise;
        expect(second.has("one")).toBe(false);

        await second.cleanup();
        secondAdapter.close();
    });

    it("round-trips Temporal PlainDate and Instant values", async () => {
        const name = databaseName();
        const first = new IndexedDBPersistenceAdapter({
            databaseName: name,
        });
        await seed(first, [
            {
                id: "temporal",
                priority: 1,
                date: Temporal.PlainDate.from("2026-07-21"),
                instant: Temporal.Instant.from("2026-07-21T12:34:56.123456789Z"),
            },
        ]);
        first.close();

        const second = new IndexedDBPersistenceAdapter({
            databaseName: name,
        });
        const [row] = await second.loadSubset("items", {});

        expect(row?.value.date).toBeInstanceOf(Temporal.PlainDate);
        expect(String(row?.value.date)).toBe("2026-07-21");
        expect(row?.value.instant).toBeInstanceOf(Temporal.Instant);
        expect(String(row?.value.instant)).toBe("2026-07-21T12:34:56.123456789Z");
        second.close();
    });

    it("uses range indexes for Temporal PlainDate and Instant values", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            {
                id: "earlier",
                priority: 1,
                date: Temporal.PlainDate.from("2026-01-01"),
                instant: Temporal.Instant.from("2026-01-01T00:00:00Z"),
            },
            {
                id: "later",
                priority: 2,
                date: Temporal.PlainDate.from("2026-08-01"),
                instant: Temporal.Instant.from("2026-08-01T00:00:00Z"),
            },
        ]);
        await adapter.ensureIndex("items", "date-index", indexSpec(["date"]));
        await adapter.ensureIndex("items", "instant-index", indexSpec(["instant"]));

        const dates = await adapter.loadSubset(
            "items",
            queryOptions((query) =>
                query.where(({ item }) => gt(item.date, Temporal.PlainDate.from("2026-06-01")))
            )
        );
        const instants = await adapter.loadSubset(
            "items",
            queryOptions((query) =>
                query.where(({ item }) => gt(item.instant, Temporal.Instant.from("2026-06-01T00:00:00Z")))
            )
        );

        expect(ids(dates)).toEqual(["later"]);
        expect(ids(instants)).toEqual(["later"]);
        adapter.close();
    });

    it("falls back to all rows when no persisted index matches", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open", status: "open", priority: 1 },
            { id: "closed", status: "closed", priority: 2 },
        ]);

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.status, "open")))
        );

        expect(ids(rows)).toEqual(["closed", "open"]);
        adapter.close();
    });

    it("uses an equality index to return candidate rows", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open-1", status: "open", priority: 1 },
            { id: "open-2", status: "open", priority: 2 },
            { id: "closed", status: "closed", priority: 3 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.status, "open")))
        );

        expect(ids(rows)).toEqual(["open-1", "open-2"]);
        adapter.close();
    });

    it("uses range indexes for homogeneous supported values", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "low", priority: 1 },
            { id: "middle", priority: 5 },
            { id: "high", priority: 10 },
        ]);
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => gt(item.priority, 4)))
        );

        expect(ids(rows)).toEqual(["high", "middle"]);
        adapter.close();
    });

    it("intersects indexed AND predicates", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open-low", status: "open", priority: 1 },
            { id: "open-high", status: "open", priority: 10 },
            { id: "closed-high", status: "closed", priority: 10 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) =>
                query.where(({ item }) => and(eq(item.status, "open"), gt(item.priority, 4)))
            )
        );

        expect(ids(rows)).toEqual(["open-high"]);
        adapter.close();
    });

    it("uses cursor.whereFrom as an index candidate predicate", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "low", priority: 1 },
            { id: "middle", priority: 5 },
            { id: "high", priority: 10 },
        ]);
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        const cursorWhere = queryOptions((query) => query.where(({ item }) => gt(item.priority, 4))).where!;

        const rows = await adapter.loadSubset("items", {
            cursor: {
                whereFrom: cursorWhere,
                whereCurrent: queryOptions((query) => query.where(({ item }) => eq(item.priority, 4))).where!,
            },
        });

        expect(ids(rows)).toEqual(["high", "middle"]);
        adapter.close();
    });

    it("intersects indexed where and cursor.whereFrom predicates", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open-low", status: "open", priority: 1 },
            { id: "open-high", status: "open", priority: 10 },
            { id: "closed-high", status: "closed", priority: 10 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        const options = queryOptions((query) => query.where(({ item }) => eq(item.status, "open")));
        const cursorWhere = queryOptions((query) => query.where(({ item }) => gt(item.priority, 4))).where!;

        const rows = await adapter.loadSubset("items", {
            ...options,
            cursor: {
                whereFrom: cursorWhere,
                whereCurrent: queryOptions((query) => query.where(({ item }) => eq(item.priority, 4))).where!,
            },
        });

        expect(ids(rows)).toEqual(["open-high"]);
        adapter.close();
    });

    it("keeps indexed where candidates when cursor.whereFrom is not indexed", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open-low", status: "open", priority: 1 },
            { id: "open-high", status: "open", priority: 10 },
            { id: "closed-high", status: "closed", priority: 10 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        const options = queryOptions((query) => query.where(({ item }) => eq(item.status, "open")));
        const cursorWhere = queryOptions((query) => query.where(({ item }) => gt(item.priority, 4))).where!;

        const rows = await adapter.loadSubset("items", {
            ...options,
            cursor: {
                whereFrom: cursorWhere,
                whereCurrent: queryOptions((query) => query.where(({ item }) => eq(item.priority, 4))).where!,
            },
        });

        expect(ids(rows)).toEqual(["open-high", "open-low"]);
        adapter.close();
    });

    it("unions indexed IN values", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open", status: "open", priority: 1 },
            { id: "pending", status: "pending", priority: 2 },
            { id: "closed", status: "closed", priority: 3 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => inArray(item.status, ["open", "pending"])))
        );

        expect(ids(rows)).toEqual(["open", "pending"]);
        adapter.close();
    });

    it("uses literal prefixes for LIKE and leaves wildcard matching residual", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "hello", name: "hello world", priority: 1 },
            { id: "help", name: "helper", priority: 2 },
            { id: "world", name: "world hello", priority: 3 },
        ]);
        await adapter.ensureIndex("items", "name-index", indexSpec(["name"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => like(item.name, "hel_o%")))
        );

        expect(ids(rows)).toEqual(["hello", "help"]);
        adapter.close();
    });

    it("uses normalized string entries for prefix ILIKE", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "hello", name: "Hello World", priority: 1 },
            { id: "helium", name: "hELium", priority: 2 },
            { id: "world", name: "world", priority: 3 },
        ]);
        await adapter.ensureIndex("items", "name-index", indexSpec(["name"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => ilike(item.name, "HEL%")))
        );

        expect(ids(rows)).toEqual(["helium", "hello"]);
        adapter.close();
    });

    it("indexes null and undefined separately", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "null", nullable: null, priority: 1 },
            { id: "missing", priority: 2 },
            { id: "value", nullable: "value", priority: 3 },
        ]);
        await adapter.ensureIndex("items", "nullable-index", indexSpec(["nullable"]));

        const nullRows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => isNull(item.nullable)))
        );
        const undefinedRows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => isUndefined(item.nullable)))
        );

        expect(ids(nullRows)).toEqual(["null"]);
        expect(ids(undefinedRows)).toEqual(["missing"]);
        adapter.close();
    });

    it("unions fully indexed OR branches", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open-low", status: "open", priority: 1 },
            { id: "open-high", status: "open", priority: 10 },
            { id: "closed", status: "closed", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) =>
                query.where(({ item }) => or(eq(item.status, "closed"), gt(item.priority, 8)))
            )
        );

        expect(ids(rows)).toEqual(["closed", "open-high"]);
        adapter.close();
    });

    it("falls back to all rows for NOT predicates", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open", status: "open", priority: 1 },
            { id: "closed", status: "closed", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => not(eq(item.status, "open"))))
        );

        expect(ids(rows)).toEqual(["closed", "open"]);
        adapter.close();
    });

    it("matches indexes on supported computed expressions", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "hello", name: "HELLO", priority: 1 },
            { id: "world", name: "WORLD", priority: 2 },
        ]);
        await adapter.ensureIndex(
            "items",
            "lower-name-index",
            expressionIndexSpec(new IR.Func("lower", [new IR.PropRef(["name"])]))
        );

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(lower(item.name), "hello")))
        );

        expect(ids(rows)).toEqual(["hello"]);
        adapter.close();
    });

    it("uses type-tagged equality lookups for mixed indexes", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "number", mixed: 1, priority: 1 },
            { id: "string", mixed: "1", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "mixed-index", indexSpec(["mixed"]));

        const numbers = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.mixed, 1)))
        );
        const strings = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.mixed, "1")))
        );

        expect(ids(numbers)).toEqual(["number"]);
        expect(ids(strings)).toEqual(["string"]);
        adapter.close();
    });

    it("keeps boolean, number, bigint, and string index values distinct", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "boolean", mixed: true, priority: 1 },
            { id: "number", mixed: 1, priority: 2 },
            { id: "bigint", mixed: 1n, priority: 3 },
            { id: "string", mixed: "1", priority: 4 },
        ]);
        await adapter.ensureIndex("items", "mixed-index", indexSpec(["mixed"]));

        const booleans = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.mixed, true)))
        );
        const numbers = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.mixed, 1)))
        );
        const bigints = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.mixed, 1n)))
        );
        const strings = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.mixed, "1")))
        );

        expect(ids(booleans)).toEqual(["boolean"]);
        expect(ids(numbers)).toEqual(["number"]);
        expect(ids(bigints)).toEqual(["bigint"]);
        expect(ids(strings)).toEqual(["string"]);
        adapter.close();
    });

    it("falls back to all rows for mixed-type ranges", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "number", mixed: 10, priority: 1 },
            { id: "string", mixed: "10", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "mixed-index", indexSpec(["mixed"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => gt(item.mixed, 4)))
        );

        expect(ids(rows)).toEqual(["number", "string"]);
        adapter.close();
    });

    it("rebuilds persisted indexes when rows change", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "one", status: "open", priority: 1 },
            { id: "two", status: "closed", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        await adapter.applyCommittedTx(
            "items",
            tx("update", 2, [
                {
                    type: "update",
                    key: "two",
                    value: { id: "two", status: "open", priority: 2 },
                },
            ])
        );

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.status, "open")))
        );

        expect(ids(rows)).toEqual(["one", "two"]);
        adapter.close();
    });

    it("falls back to a full scan after an index is removed", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "open", status: "open", priority: 1 },
            { id: "closed", status: "closed", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));
        await adapter.markIndexRemoved("items", "status-index");

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => eq(item.status, "open")))
        );

        expect(ids(rows)).toEqual(["closed", "open"]);
        adapter.close();
    });

    it("deduplicates committed transaction ids and restores stream position", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        const committed = tx("same-id", 1, [
            {
                type: "insert",
                key: "one",
                value: { id: "one", status: "open", priority: 1 },
            },
        ]);

        await adapter.applyCommittedTx("items", committed);
        await adapter.applyCommittedTx("items", committed);

        expect(ids(await adapter.loadSubset("items", {}))).toEqual(["one"]);
        await expect(adapter.getStreamPosition("items")).resolves.toMatchObject({
            latestTerm: 1,
            latestSeq: 1,
            latestRowVersion: 1,
        });
        adapter.close();
    });

    it("uses range indexes when omitted values are nullish", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
        });
        await seed(adapter, [
            { id: "missing", priority: 0 },
            { id: "open", status: "open", priority: 1 },
            { id: "closed", status: "closed", priority: 2 },
        ]);
        await adapter.ensureIndex("items", "status-index", indexSpec(["status"]));

        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) => query.where(({ item }) => gt(item.status, "a")))
        );

        expect(ids(rows)).toEqual(["closed", "open"]);
        adapter.close();
    });
});

describe("IndexedDB persistence lifecycle and paging", () => {
    it("clears collection initialization state on close and cannot repopulate it while opening", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        for (let index = 0; index < 20; index++) await adapter.loadResumeSnapshot(`dynamic-${index}`);
        const initialized = Reflect.get(adapter, "initialized") as Map<string, unknown>;
        expect(initialized.size).toBe(20);
        adapter.close();
        expect(initialized.size).toBe(0);
        const opening = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        const load = opening.loadResumeSnapshot("pending");
        opening.close();
        await expect(load).rejects.toThrow("closed");
        expect((Reflect.get(opening, "initialized") as Map<string, unknown>).size).toBe(0);
    });

    it("bounds dynamic collection initialization state while preserving concurrent operations and persisted data", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        try {
            await adapter.applyCommittedTx("saved", tx("seed", 1, [{ type: "insert", key: "one", value: { id: "one", priority: 1 } }]));
            await Promise.all(Array.from({ length: 160 }, (_, index) => adapter.loadResumeSnapshot(`dynamic-${index}`)));
            expect((Reflect.get(adapter, "initialized") as Map<string, unknown>).size).toBeLessThanOrEqual(128);
            expect((await adapter.loadResumeSnapshot("saved")).rows).toHaveLength(1);
        } finally {
            adapter.close();
        }
    });

    it("rejects local schema mismatches without changing data", async () => {
        const name = databaseName();
        const original = new IndexedDBPersistenceAdapter({ databaseName: name });
        await seed(original, [{ id: "saved", priority: 1 }]);
        const next = new IndexedDBPersistenceAdapter({
            databaseName: name,
            schemaVersion: 2,
            schemaMismatchPolicy: "sync-absent-error",
        });
        await expect(next.loadResumeSnapshot("items")).rejects.toThrow("Local-only data was preserved");
        expect(ids(await original.loadSubset("items", {}))).toEqual(["saved"]);
        next.close();
        original.close();
    });

    it("resets synced schemas atomically and fences old adapters", async () => {
        const name = databaseName();
        const original = new IndexedDBPersistenceAdapter({ databaseName: name });
        await original.applyCommittedTx("items", {
            ...tx("seed", 1, [{ type: "insert", key: "old", value: { id: "old", priority: 1 } }]),
            collectionMetadataMutations: [{ type: "set", key: "cursor", value: "old" }],
        });
        await original.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        const next = new IndexedDBPersistenceAdapter({
            databaseName: name,
            schemaMismatchPolicy: "sync-present-reset",
            schemaVersion: 2,
        });
        const snapshot = await next.loadResumeSnapshot("items");
        expect(snapshot).toMatchObject({
            rows: [],
            collectionMetadata: [],
            resetEpoch: 1,
            latestRowVersion: 2,
        });
        await expect(
            original.applyCommittedTx(
                "items",
                tx("stale", 3, [{ type: "insert", key: "stale", value: { id: "stale", priority: 3 } }])
            )
        ).rejects.toThrow("stale IndexedDB adapter");
        await expect(original.loadSubset("items", {})).rejects.toThrow("stale IndexedDB adapter");
        await expect(
            original.ensureIndex("items", "priority-index", indexSpec(["priority"]))
        ).rejects.toThrow("stale IndexedDB adapter");
        const reopenedOld = new IndexedDBPersistenceAdapter({ databaseName: name });
        await expect(reopenedOld.loadSubset("items", {})).rejects.toThrow("refusing to downgrade");
        expect(await next.pullSince("items", 1)).toMatchObject({
            latestRowVersion: 2,
            requiresFullReload: true,
        });
        reopenedOld.close();
        next.close();
        original.close();
    });

    it("allows a fresh local-only collection to start at a higher schema version", async () => {
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
            schemaVersion: 5,
            schemaMismatchPolicy: "sync-absent-error",
        });
        expect(await adapter.loadResumeSnapshot("items")).toMatchObject({ rows: [], resetEpoch: 0 });
        adapter.close();
    });

    it("replays row and metadata changes with Temporal values and deduplicates retries", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        const instant = Temporal.Instant.from("2026-10-05T12:00:00.000000001Z");
        await seed(adapter, [
            { id: "a", priority: 1 },
            { id: "b", priority: 2 },
        ]);
        const edit = {
            ...tx("edit", 2, [
                { type: "update" as const, key: "a", value: { id: "a", priority: 3, instant } },
                { type: "delete" as const, key: "b", value: { id: "b", priority: 2 } },
            ]),
            rowMetadataMutations: [{ type: "set" as const, key: "a", value: { owner: "query" } }],
            collectionMetadataMutations: [{ type: "set" as const, key: "cursor", value: instant }],
        };
        await adapter.applyCommittedTx("items", edit);
        await adapter.applyCommittedTx("items", edit);
        expect(await adapter.pullSince("items", 1)).toMatchObject({
            latestRowVersion: 2,
            requiresFullReload: false,
            changedKeys: ["a"],
            deletedKeys: ["b"],
            deltas: [
                {
                    txId: "edit",
                    latestRowVersion: 2,
                    changedRows: [{ key: "a", value: { id: "a", priority: 3, instant } }],
                    deletedKeys: ["b"],
                    rowMetadataMutations: [{ type: "set", key: "a", value: { owner: "query" } }],
                    collectionMetadataMutations: [{ type: "set", key: "cursor", value: instant }],
                },
            ],
        });
        expect(await adapter.pullSince("items", 2)).toMatchObject({
            latestRowVersion: 2,
            requiresFullReload: false,
            changedKeys: [],
            deletedKeys: [],
            deltas: [],
        });
        adapter.close();
    });

    it("bounds retained history and reloads when history, truncate, or change count prevents replay", async () => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: name,
            appliedTxPruneMaxRows: 2,
            pullSinceReloadThreshold: 0,
        });
        await seed(adapter, [{ id: "a", priority: 1 }]);
        await adapter.applyCommittedTx("items", tx("metadata", 2, []));
        await adapter.applyCommittedTx("items", tx("metadata-2", 3, []));
        const database = await openDB(name, 2);
        expect(await database.countFromIndex("transactions", "collectionId", "items")).toBe(2);
        expect(await adapter.pullSince("items", 0)).toMatchObject({
            latestRowVersion: 3,
            requiresFullReload: true,
        });
        expect(await adapter.pullSince("items", 1)).toMatchObject({
            latestRowVersion: 3,
            requiresFullReload: false,
            deltas: [{ txId: "metadata" }, { txId: "metadata-2" }],
        });
        await adapter.applyCommittedTx("items", { ...tx("truncate", 4, []), truncate: true });
        expect(await adapter.pullSince("items", 3)).toMatchObject({
            latestRowVersion: 4,
            requiresFullReload: true,
        });
        await adapter.applyCommittedTx(
            "items",
            tx("insert", 5, [{ type: "insert", key: "b", value: { id: "b", priority: 2 } }])
        );
        expect(await adapter.pullSince("items", 4)).toMatchObject({
            latestRowVersion: 5,
            requiresFullReload: true,
        });
        database.close();
        adapter.close();
    });

    it("prunes by age and handles an empty retention window", async () => {
        const name = databaseName();
        const adapter = new IndexedDBPersistenceAdapter({
            databaseName: name,
            appliedTxPruneMaxAgeSeconds: 10,
        });
        await seed(adapter, [{ id: "a", priority: 1 }]);
        const database = await openDB(name, 2);
        const record = (await database.getAllFromIndex("transactions", "collectionId", "items"))[0] as {
            id: string;
            collectionId: string;
            rowVersion: number;
            appliedAt: number;
            delta: unknown;
        };
        await database.put("transactions", { ...record, appliedAt: Date.now() - 11000 });
        await adapter.applyCommittedTx("items", tx("fresh", 2, []));
        expect(await database.countFromIndex("transactions", "collectionId", "items")).toBe(1);
        expect(await adapter.pullSince("items", 0)).toMatchObject({ requiresFullReload: true });
        database.close();
        adapter.close();
        const noHistory = new IndexedDBPersistenceAdapter({
            databaseName: databaseName(),
            appliedTxPruneMaxRows: 0,
        });
        await seed(noHistory, [{ id: "a", priority: 1 }]);
        expect(await noHistory.pullSince("items", 0)).toMatchObject({ requiresFullReload: true });
        expect(await noHistory.pullSince("items", 1)).toMatchObject({
            requiresFullReload: false,
            deltas: [],
        });
        noHistory.close();
    });

    it("selects metadata rows through the metadata index and retains their values", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await adapter.applyCommittedTx("items", {
            ...tx("seed", 1, [
                {
                    type: "insert",
                    key: "owned",
                    value: { id: "owned", priority: 1 },
                    metadata: { owners: ["query"] },
                    metadataChanged: true,
                },
                { type: "insert", key: "plain", value: { id: "plain", priority: 2 } },
            ]),
        });
        const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
        try {
            const rows = await adapter.scanRows("items", { metadataOnly: true });
            expect(rows).toEqual([
                { key: "owned", value: { id: "owned", priority: 1 }, metadata: { owners: ["query"] } },
            ]);
            expect(getAll.mock.contexts.map((instance) => (instance as IDBIndex).name)).toEqual(["metadata"]);
        } finally {
            getAll.mockRestore();
        }
        await adapter.applyCommittedTx("items", {
            ...tx("clear", 2, []),
            rowMetadataMutations: [{ type: "delete", key: "owned" }],
        });
        expect(await adapter.scanRows("items", { metadataOnly: true })).toEqual([]);
        adapter.close();
    });

    it("stops ordered indexed reads after a page and filters before applying offset", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(
            adapter,
            Array.from({ length: 100 }, (_, index) => ({
                id: `row-${index}`,
                priority: index,
                status: index % 2 ? "open" : "closed",
            }))
        );
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
        const get = vi.spyOn(IDBObjectStore.prototype, "get");
        try {
            const rows = await adapter.loadSubset(
                "items",
                queryOptions((query) =>
                    query
                        .where(({ item }) => eq(item.status, "open"))
                        .orderBy(({ item }) => item.priority, "desc")
                        .offset(2)
                        .limit(3)
                )
            );
            expect(rows.map((row) => row.key)).toEqual(["row-95", "row-93", "row-91"]);
            expect(
                getAll.mock.contexts.every((instance) => (instance as IDBIndex).objectStore.name !== "rows")
            ).toBe(true);
            expect(
                get.mock.contexts.filter((instance) => (instance as IDBObjectStore).name === "rows").length
            ).toBeLessThan(15);
            get.mockClear();
            const tail = await adapter.loadSubset(
                "items",
                queryOptions((query) =>
                    query
                        .where(({ item }) => gt(item.priority, 90))
                        .orderBy(({ item }) => item.priority, "asc")
                        .limit(2)
                )
            );
            expect(tail.map((row) => row.key)).toEqual(["row-91", "row-92"]);
            expect(
                get.mock.contexts.filter((instance) => (instance as IDBObjectStore).name === "rows").length
            ).toBe(2);
        } finally {
            getAll.mockRestore();
            get.mockRestore();
        }
        adapter.close();
    });

    it("falls back for mixed types, nulls, locale strings, and composite ordering", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(adapter, [
            { id: "null", priority: 1, name: undefined },
            { id: "z", priority: 1, name: "z" },
            { id: "a", priority: 2, name: "a" },
        ]);
        await adapter.ensureIndex("items", "name-index", indexSpec(["name"]));
        const rows = await adapter.loadSubset(
            "items",
            queryOptions((query) =>
                query
                    .orderBy(({ item }) => item.name, {
                        direction: "desc",
                        nulls: "last",
                        stringSort: "locale",
                    })
                    .limit(2)
            )
        );
        expect(rows.map((row) => row.key)).toEqual(["z", "a"]);
        const composite = await adapter.loadSubset(
            "items",
            queryOptions((query) =>
                query
                    .orderBy(({ item }) => item.priority, "asc")
                    .orderBy(({ item }) => item.name, { direction: "desc", nulls: "last" })
                    .limit(2)
            )
        );
        expect(composite.map((row) => row.key)).toEqual(["z", "null"]);
        adapter.close();
    });

    it("keeps all current cursor ties while limiting the following page", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(adapter, [
            { id: "a", priority: 2 },
            { id: "b", priority: 2 },
            { id: "c", priority: 3 },
            { id: "d", priority: 4 },
        ]);
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        const order = queryOptions((query) => query.orderBy(({ item }) => item.priority, "asc"));
        const rows = await adapter.loadSubset("items", {
            ...order,
            limit: 1,
            cursor: {
                whereCurrent: queryOptions((query) => query.where(({ item }) => eq(item.priority, 2))).where!,
                whereFrom: queryOptions((query) => query.where(({ item }) => gt(item.priority, 2))).where!,
            },
        });
        expect(rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
        adapter.close();
    });
});

describe("IndexedDB compatibility", () => {
    it("upgrades a version-1 database without losing rows or metadata", async () => {
        const name = databaseName();
        const legacy = await openDB(name, 1, {
            upgrade(database) {
                const rows = database.createObjectStore("rows", { keyPath: "id" });
                rows.createIndex("collectionId", "collectionId");
                const transactions = database.createObjectStore("transactions", { keyPath: "id" });
                transactions.createIndex("collectionId", "collectionId");
                const metadata = database.createObjectStore("collectionMetadata", { keyPath: "id" });
                metadata.createIndex("collectionId", "collectionId");
                database.createObjectStore("streams", { keyPath: "collectionId" });
                const definitions = database.createObjectStore("indexDefinitions", {
                    keyPath: ["collectionId", "signature"],
                });
                definitions.createIndex("collectionId", "collectionId");
                const entries = database.createObjectStore("indexEntries", {
                    keyPath: ["collectionId", "signature", "valueType", "rowId"],
                });
                entries.createIndex("collectionId", "collectionId");
                entries.createIndex("index", ["collectionId", "signature"]);
                entries.createIndex("lookup", ["collectionId", "signature", "valueType", "value", "rowId"]);
            },
        });
        await legacy.put("rows", {
            id: JSON.stringify(["items", "s:owned"]),
            collectionId: "items",
            key: "owned",
            value: { id: "owned", priority: 1 },
            metadata: { owners: ["query"] },
        });
        await legacy.put("rows", {
            id: JSON.stringify(["items", "s:plain"]),
            collectionId: "items",
            key: "plain",
            value: { id: "plain", priority: 2 },
        });
        await legacy.put("streams", {
            collectionId: "items",
            latestTerm: 1,
            latestSeq: 1,
            latestRowVersion: 1,
        });
        await legacy.put("transactions", { id: JSON.stringify(["items", "old"]), collectionId: "items" });
        legacy.close();
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: name });
        expect(ids(await adapter.loadSubset("items", {}))).toEqual(["owned", "plain"]);
        expect(await adapter.scanRows("items", { metadataOnly: true })).toEqual([
            { key: "owned", value: { id: "owned", priority: 1 }, metadata: { owners: ["query"] } },
        ]);
        expect(await adapter.pullSince("items", 0)).toMatchObject({ requiresFullReload: true });
        await adapter.applyCommittedTx(
            "items",
            tx("old", 1, [{ type: "update", key: "owned", value: { id: "owned", priority: 99 } }])
        );
        expect(
            (await adapter.loadSubset("items", {})).find((row) => row.key === "owned")?.value.priority
        ).toBe(1);
        await adapter.applyCommittedTx(
            "items",
            tx("edit", 2, [{ type: "update", key: "owned", value: { id: "owned", priority: 3 } }])
        );
        expect(await adapter.pullSince("items", 1)).toMatchObject({
            requiresFullReload: false,
            changedKeys: ["owned"],
        });
        adapter.close();
    });

    it("does not confuse nested fields with top-level indexes", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(adapter, [
            { id: "a", priority: 1, details: { priority: 10 } },
            { id: "b", priority: 10, details: { priority: 1 } },
        ]);
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        const nested = new IR.PropRef<number>(["details", "priority"]);
        const rows = await adapter.loadSubset("items", {
            where: new IR.Func<boolean>("eq", [nested, new IR.Value(10)]),
            limit: 1,
        });
        expect(rows.map((row) => row.key)).toEqual(["a"]);
        const ordered = await adapter.loadSubset("items", {
            orderBy: [
                {
                    expression: nested,
                    compareOptions: { direction: "desc", nulls: "last", stringSort: "lexical" },
                },
            ],
            limit: 1,
        });
        expect(ordered.map((row) => row.key)).toEqual(["a"]);
        adapter.close();
    });
});

describe("IndexedDB partial updates", () => {
    it("merges partial row updates and replays the full stored row", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await seed(adapter, [{ id: "a", priority: 1, name: "Retained" }]);
        await adapter.ensureIndex("items", "name-index", indexSpec(["name"]));
        await adapter.ensureIndex("items", "priority-index", indexSpec(["priority"]));
        await adapter.applyCommittedTx("items", {
            ...tx("patch", 2, []),
            mutations: [{ type: "update", key: "a", value: { priority: 5 } }],
        });
        expect(
            await adapter.loadSubset(
                "items",
                queryOptions((query) => query.where(({ item }) => eq(item.name, "Retained")))
            )
        ).toEqual([{ key: "a", value: { id: "a", priority: 5, name: "Retained" }, metadata: undefined }]);
        expect(await adapter.pullSince("items", 1)).toMatchObject({
            requiresFullReload: false,
            deltas: [{ changedRows: [{ key: "a", value: { id: "a", priority: 5, name: "Retained" } }] }],
        });
        adapter.close();
    });

    it("honors metadataChanged instead of silently replacing unchanged metadata", async () => {
        const adapter = new IndexedDBPersistenceAdapter({ databaseName: databaseName() });
        await adapter.applyCommittedTx(
            "items",
            tx("seed", 1, [
                {
                    type: "insert",
                    key: "a",
                    value: { id: "a", priority: 1 },
                    metadataChanged: true,
                    metadata: { owner: "saved" },
                },
            ])
        );
        await adapter.applyCommittedTx("items", {
            ...tx("patch", 2, []),
            mutations: [{ type: "update", key: "a", value: { priority: 2 }, metadata: { owner: "ignored" } }],
        });
        expect(await adapter.scanRows("items", { metadataOnly: true })).toMatchObject([
            { key: "a", metadata: { owner: "saved" } },
        ]);
        await adapter.applyCommittedTx("items", {
            ...tx("clear", 3, []),
            mutations: [
                {
                    type: "update",
                    key: "a",
                    value: { priority: 3 },
                    metadataChanged: true,
                    metadata: undefined,
                },
            ],
        });
        expect(await adapter.scanRows("items", { metadataOnly: true })).toEqual([]);
        expect(await adapter.pullSince("items", 2)).toMatchObject({
            requiresFullReload: false,
            deltas: [{ rowMetadataMutations: [{ type: "delete", key: "a" }] }],
        });
        adapter.close();
    });
});
