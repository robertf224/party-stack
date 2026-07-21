import "fake-indexeddb/auto";
import {
    IR,
    and,
    createCollection,
    eq,
    gt,
    ilike,
    inArray,
    isNull,
    isUndefined,
    like,
    lower,
    not,
    or,
} from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { IndexedDBPersistenceAdapter } from "./IndexedDBPersistenceAdapter.js";
import type {
    PersistedIndexSpec,
    PersistedTx,
} from "@tanstack/db-sqlite-persistence-core";

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

function databaseName(): string {
    return `runtime-services-${crypto.randomUUID()}`;
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

function expressionIndexSpec(
    expression: IR.BasicExpression
): PersistedIndexSpec {
    return {
        expressionSql: [JSON.stringify(expression)],
    };
}

async function seed(
    adapter: IndexedDBPersistenceAdapter,
    items: Item[]
): Promise<void> {
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
        expect(String(row?.value.instant)).toBe(
            "2026-07-21T12:34:56.123456789Z"
        );
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
        await adapter.ensureIndex(
            "items",
            "date-index",
            indexSpec(["date"])
        );
        await adapter.ensureIndex(
            "items",
            "instant-index",
            indexSpec(["instant"])
        );

        const dates = await adapter.loadSubset("items", {
            where: gt(
                new IR.PropRef(["item", "date"]),
                Temporal.PlainDate.from("2026-06-01")
            ),
        });
        const instants = await adapter.loadSubset("items", {
            where: gt(
                new IR.PropRef(["item", "instant"]),
                Temporal.Instant.from("2026-06-01T00:00:00Z")
            ),
        });

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

        const rows = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "status"]), "open"),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );

        const rows = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "status"]), "open"),
        });

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
        await adapter.ensureIndex(
            "items",
            "priority-index",
            indexSpec(["priority"])
        );

        const rows = await adapter.loadSubset("items", {
            where: gt(new IR.PropRef(["item", "priority"]), 4),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );
        await adapter.ensureIndex(
            "items",
            "priority-index",
            indexSpec(["priority"])
        );

        const rows = await adapter.loadSubset("items", {
            where: and(
                eq(new IR.PropRef(["item", "status"]), "open"),
                gt(new IR.PropRef(["item", "priority"]), 4)
            ),
        });

        expect(ids(rows)).toEqual(["open-high"]);
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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );

        const rows = await adapter.loadSubset("items", {
            where: inArray(new IR.PropRef(["item", "status"]), [
                "open",
                "pending",
            ]),
        });

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
        await adapter.ensureIndex(
            "items",
            "name-index",
            indexSpec(["name"])
        );

        const rows = await adapter.loadSubset("items", {
            where: like(
                new IR.PropRef<string>(["item", "name"]),
                "hel_o%"
            ),
        });

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
        await adapter.ensureIndex(
            "items",
            "name-index",
            indexSpec(["name"])
        );

        const rows = await adapter.loadSubset("items", {
            where: ilike(
                new IR.PropRef<string>(["item", "name"]),
                "HEL%"
            ),
        });

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
        await adapter.ensureIndex(
            "items",
            "nullable-index",
            indexSpec(["nullable"])
        );

        const nullRows = await adapter.loadSubset("items", {
            where: isNull(new IR.PropRef(["item", "nullable"])),
        });
        const undefinedRows = await adapter.loadSubset("items", {
            where: isUndefined(new IR.PropRef(["item", "nullable"])),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );
        await adapter.ensureIndex(
            "items",
            "priority-index",
            indexSpec(["priority"])
        );

        const rows = await adapter.loadSubset("items", {
            where: or(
                eq(new IR.PropRef(["item", "status"]), "closed"),
                gt(new IR.PropRef(["item", "priority"]), 8)
            ),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );

        const rows = await adapter.loadSubset("items", {
            where: not(eq(new IR.PropRef(["item", "status"]), "open")),
        });

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
            expressionIndexSpec(
                new IR.Func("lower", [new IR.PropRef(["name"])])
            )
        );

        const rows = await adapter.loadSubset("items", {
            where: eq(
                lower(new IR.PropRef(["item", "name"])),
                "hello"
            ),
        });

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
        await adapter.ensureIndex(
            "items",
            "mixed-index",
            indexSpec(["mixed"])
        );

        const numbers = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "mixed"]), 1),
        });
        const strings = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "mixed"]), "1"),
        });

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
        await adapter.ensureIndex(
            "items",
            "mixed-index",
            indexSpec(["mixed"])
        );

        const booleans = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "mixed"]), true),
        });
        const numbers = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "mixed"]), 1),
        });
        const bigints = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "mixed"]), 1n),
        });
        const strings = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "mixed"]), "1"),
        });

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
        await adapter.ensureIndex(
            "items",
            "mixed-index",
            indexSpec(["mixed"])
        );

        const rows = await adapter.loadSubset("items", {
            where: gt(new IR.PropRef(["item", "mixed"]), 4),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );
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

        const rows = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "status"]), "open"),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );
        await adapter.markIndexRemoved("items", "status-index");

        const rows = await adapter.loadSubset("items", {
            where: eq(new IR.PropRef(["item", "status"]), "open"),
        });

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
        await adapter.ensureIndex(
            "items",
            "status-index",
            indexSpec(["status"])
        );

        const rows = await adapter.loadSubset("items", {
            where: gt(new IR.PropRef(["item", "status"]), "a"),
        });

        expect(ids(rows)).toEqual(["closed", "open"]);
        adapter.close();
    });
});
