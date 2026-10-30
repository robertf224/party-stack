import * as Memory from "@party-stack/ontology-storage/memory/tables";
import {
    Table,
    OntologyStorageError,
    TransactionError,
    type TablesService,
} from "@party-stack/ontology-storage/tables";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { runtimeFixtureContext } from "@party-stack/runtime/testing";
import { memoryRuntimeFixture, defineRuntimeFixture } from "@party-stack/runtime/testing";
import { eq, queryOnce } from "@tanstack/db";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { createLocalCollection } from "./createLocalCollection.js";
import type { RuntimeFixtureOptions } from "@party-stack/runtime/testing";

interface Item {
    id: string;
    title: string;
}
function provider(tables: TablesService) {
    return defineRuntimeFixture((owner, namespace) => {
        return {
            owner,
            namespace,

            tables: Effect.succeed(tables),
            blobBytes: new MemoryBlobBytesStore(),
        };
    });
}
const open = (runtime: RuntimeFixtureOptions, name = "items", schemaVersion = 1) =>
    createLocalCollection<Item, string>({
        name,
        schemaVersion,
        runtime: runtimeFixtureContext(runtime).service,
        scope: runtimeFixtureContext(runtime).scope,
        getKey: (item) => item.id,
    });
const rows = (collection: ReturnType<typeof open>) => queryOnce((q) => q.from({ row: collection }));

test("default runtime collections use owned memory tables and survive collection close/reopen", async () => {
    const runtime = memoryRuntimeFixture("owner", "memory");
    const first = open(runtime);
    try {
        await rows(first);
        await first.insert({ id: "one", title: "Stored" }).isPersisted.promise;
        await first.cleanup();
        const second = open(runtime);
        try {
            expect(await rows(second)).toMatchObject([{ id: "one", title: "Stored" }]);
        } finally {
            await second.cleanup();
        }
    } finally {
        await first.cleanup();
        await runtime.cleanup?.();
    }
});

test("untyped local predicates keep filtering and limiting in TanStack when semantics are unknown", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const table = Table.make<Item>({ name: JSON.stringify(["local", "owner", "subset", "items"]) });
    await Effect.runPromise(tables.put(table, "one", { id: "one", title: "Selected" }));
    await Effect.runPromise(tables.put(table, "two", { id: "two", title: "Unrelated" }));
    const load = vi.spyOn(tables, "query");
    const runtime = provider(tables)("owner", "subset");
    const collection = open(runtime);
    try {
        expect(
            await queryOnce((q) =>
                q
                    .from({ item: collection })
                    .where(({ item }) => eq(item.title, "Unrelated"))
                    .orderBy(({ item }) => item.id, "asc")
                    .limit(1)
            )
        ).toMatchObject([{ id: "two" }]);
        expect(load.mock.calls.length).toBeGreaterThan(0);
        expect(load.mock.calls.every(([, query]) => !query?.where && query?.limit === undefined)).toBe(true);
    } finally {
        await collection.cleanup();
        await runtime.cleanup?.();
    }
});

test("collections in one owner observe committed local writes", async () => {
    const create = provider(await Effect.runPromise(Memory.make()));
    const a = create("owner", "shared");
    const b = a;
    const first = open(a);
    const second = open(b);
    const subscriptions = [first, second].map((collection) =>
        collection.subscribeChanges(() => {}, { includeInitialState: true })
    );
    try {
        await Promise.all([rows(first), rows(second)]);
        await first.insert({ id: "one", title: "Initial" }).isPersisted.promise;
        await vi.waitFor(() => expect(second.get("one")?.title).toBe("Initial"));
        await second.update("one", (draft) => {
            draft.title = "Other collection";
        }).isPersisted.promise;
        await vi.waitFor(() => expect(first.get("one")?.title).toBe("Other collection"));
        await first.delete("one").isPersisted.promise;
        await vi.waitFor(() => expect(second.has("one")).toBe(false));
    } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        await first.cleanup();
        await second.cleanup();
        await a.cleanup?.();
        await b.cleanup?.();
    }
});

test("concurrent collections in one owner preserve all rows in native transactions", async () => {
    const create = provider(await Effect.runPromise(Memory.make()));
    const a = create("owner", "concurrent");
    const b = a;
    const first = open(a);
    const second = open(b);
    const subscriptions = [first, second].map((collection) =>
        collection.subscribeChanges(() => {}, { includeInitialState: true })
    );
    try {
        await Promise.all([rows(first), rows(second)]);
        await Promise.all(
            Array.from(
                { length: 20 },
                (_, i) =>
                    (i % 2 ? first : second).insert({ id: String(i), title: `Item ${i}` }).isPersisted.promise
            )
        );
        await vi.waitFor(() => {
            expect(first.size).toBe(20);
            expect(second.size).toBe(20);
        });
    } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        await first.cleanup();
        await second.cleanup();
        await a.cleanup?.();
        await b.cleanup?.();
    }
});

test("namespace and schema guards preserve existing local rows", async () => {
    const create = provider(await Effect.runPromise(Memory.make()));
    const a = create("owner", "one");
    const b = create("owner", "two");
    const first = open(a);
    const other = open(b);
    try {
        await Promise.all([rows(first), rows(other)]);
        await first.insert({ id: "one", title: "Private" }).isPersisted.promise;
        expect(other.has("one")).toBe(false);
        await first.cleanup();
        const incompatible = open(a, "items", 2);
        try {
            await expect(rows(incompatible)).rejects.toMatchObject({
                _tag: "OntologyStorageError",
                reason: { _tag: "SchemaMismatch" },
            });
        } finally {
            await incompatible.cleanup();
        }
        const reopened = open(a);
        try {
            expect(await rows(reopened)).toMatchObject([{ id: "one", title: "Private" }]);
        } finally {
            await reopened.cleanup();
        }
    } finally {
        await first.cleanup();
        await other.cleanup();
        await a.cleanup?.();
        await b.cleanup?.();
    }
});

test("failed storage writes roll back optimistic publication", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const runtime = provider({
        ...tables,
        transaction: () =>
            Effect.fail(
                new OntologyStorageError({
                    operation: "test",
                    reason: new TransactionError({
                        kind: "Backend",
                        message: "Write failed",
                        retryable: true,
                    }),
                })
            ),
    })("owner", "failure");
    const collection = open(runtime);
    try {
        await rows(collection);
        await expect(
            collection.insert({ id: "failed", title: "Not committed" }).isPersisted.promise
        ).rejects.toBeDefined();
        expect(collection.has("failed")).toBe(false);
    } finally {
        await collection.cleanup();
        await runtime.cleanup?.();
    }
});
