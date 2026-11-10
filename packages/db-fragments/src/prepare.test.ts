import {
    BaseQueryBuilder,
    BasicIndex,
    collectionOptions,
    DbClient,
    localOnlyCollectionOptions,
    Query,
    eq,
} from "@tanstack/db";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { prepareListQuery, prepareQuery } from "./prepare.js";
import { useListFragment } from "./react.js";
import { defineFragment, defineListFragment, type FragmentRef, type ListFragmentRef } from "./index.js";
import type { SingleResult } from "@tanstack/db";

const notes = collectionOptions("prepared-notes", (client) =>
    localOnlyCollectionOptions<{ id: string; title: string; rank: number }>({
        id: "prepared-notes",
        getKey: (row) => row.id,
        initialData: Array.from({ length: 60 }, (_, rank) => ({
            id: String(rank),
            title: `${client.requireDependency<string>("label")} ${rank}`,
            rank,
        })),
        autoIndex: "eager",
        defaultIndexType: BasicIndex,
    })
);

test("prepared queries bind descriptor fragment trees per client and preserve findOne typing", async () => {
    const title = defineFragment(notes, (row) => ({ title: row.title }), { key: (row) => row.id });
    const query = new Query()
        .from({ note: notes })
        .where(({ note }) => eq(note.id, "0"))
        .select(({ note }) => ({ id: note.id, detail: title.include(note) }))
        .findOne();
    const clients = [new DbClient({ label: "First" }), new DbClient({ label: "Second" })];
    const prepared = clients.map((client) => prepareQuery(client, query));
    try {
        await Promise.all(prepared.map((entry) => entry.ready));
        expect(prepared.map((entry) => entry.collection.toArray[0]?.detail.toArray[0]?.title)).toEqual([
            "First 0",
            "Second 0",
        ]);
        expectTypeOf(prepared[0]!.collection).toExtend<SingleResult>();
        expectTypeOf(prepared[0]!.collection.toArray[0]!.id).toEqualTypeOf<string>();
        const detail: FragmentRef<typeof title> = prepared[0]!.collection.toArray[0]!.detail;
        expect(detail.toArray[0]?.title).toBe("First 0");
        // The same graph stays reactive after its preparation lease is handed off.
        const consumer = prepared[0]!.collection.subscribeChanges(() => {});
        try {
            prepared[0]!.release();
            prepared[0]!.release();
            await clients[0]!
                .collection(notes)
                .update("0", (row) => {
                    row.title = "Changed";
                })
                .when("settled");
            expect(detail.toArray[0]?.title).toBe("Changed");
        } finally {
            consumer.unsubscribe();
        }
    } finally {
        await Promise.all(prepared.map((entry) => entry.cleanup()));
        await Promise.all(clients.map((client) => client.cleanup()));
    }
});

test("prepared lists acquire a sentinel without changing the authored page size or selected types", async () => {
    const client = new DbClient({ label: "Note" });
    const query = new Query()
        .from({ note: notes })
        .orderBy(({ note }) => note.rank)
        .limit(50)
        .select(({ note }) => ({ id: note.id, title: note.title }));
    const prepared = prepareListQuery(client, query, { gcTime: 25 });
    const fragment = defineListFragment(notes, (scope) =>
        scope
            .orderBy(({ row }) => row.rank)
            .limit(50)
            .select(({ row }) => ({ id: row.id, title: row.title }))
    );
    function TypecheckReader(child: ListFragmentRef<typeof fragment>, chooseRoot: boolean) {
        const root = useListFragment(prepared.collection);
        const included = useListFragment(child);
        const union = useListFragment(chooseRoot ? prepared.collection : child);
        const queryOrCollection = useListFragment(chooseRoot ? prepared.collection : query);
        expectTypeOf(root.data[0]!.title).toEqualTypeOf<string>();
        expectTypeOf(included.data[0]!.title).toEqualTypeOf<string>();
        expectTypeOf(union.data[0]!.title).toEqualTypeOf<string>();
        expectTypeOf(queryOrCollection.data[0]!.title).toEqualTypeOf<string>();
        expectTypeOf(root.data[0]!).not.toBeNever();
        expectTypeOf(included.data[0]!).not.toBeNever();
        expectTypeOf(union.data[0]!).not.toBeNever();
        expectTypeOf(queryOrCollection.data[0]!).not.toBeNever();
        // @ts-expect-error The native root/child union retains its selection.
        void union.data[0]!.rank;
    }
    void TypecheckReader;
    try {
        await prepared.ready;
        expect(prepared.collection.toArray).toHaveLength(51);
        expect(prepared.collection.utils.getWindow()).toMatchObject({ offset: 0, limit: 51 });
        expect((query as unknown as BaseQueryBuilder)._getQuery().limit).toBe(50);
        expect(prepared.collection.config.gcTime).toBe(25);
        expectTypeOf(prepared.collection.toArray[0]!.title).toEqualTypeOf<string>();
        // @ts-expect-error Preparation does not widen the selected result to the source row.
        void prepared.collection.toArray[0]!.rank;
        const cleanup = prepared.cleanup();
        expect(prepared.cleanup()).toBe(cleanup);
        await cleanup;
        expect(prepared.collection.status).toBe("cleaned-up");
    } finally {
        await prepared.cleanup();
        await client.cleanup();
    }
});

test("list preparation rejects invalid windows before starting source sync", async () => {
    let starts = 0;
    const client = new DbClient();
    const descriptor = collectionOptions<{ id: string }>({
        id: "invalid-list",
        getKey: (row) => row.id,
        sync: {
            sync: ({ markReady }) => {
                starts++;
                markReady();
            },
        },
    });
    try {
        expect(() => prepareListQuery(client, (q) => q.from({ note: descriptor }).limit(1))).toThrow(
            "orderBy"
        );
        expect(() =>
            prepareListQuery(client, (q) =>
                q
                    .from({ note: descriptor })
                    .orderBy(({ note }) => note.id)
                    .offset(1)
            )
        ).toThrow("offset zero");
        expect(starts).toBe(0);
        const checkTypes = () => {
            // @ts-expect-error A singular query cannot be prepared as a paginated list.
            prepareListQuery(client, (q) => q.from({ note: descriptor }).findOne());
            // @ts-expect-error Root scalar results are not Collection rows.
            prepareQuery(client, (q) => q.from({ note: descriptor }).select(({ note }) => note.id));
        };
        void checkTypes;
    } finally {
        await client.cleanup();
    }
});

test("failed preparation releases its graph and keeps the original error", async () => {
    const failure = new Error("Source failed");
    const client = new DbClient();
    let releases = 0;
    let cleanups = 0;
    const descriptor = collectionOptions<{ id: string }>({
        id: "failed-preparation",
        getKey: (row) => row.id,
        gcTime: 1,
        syncMode: "on-demand",
        sync: {
            sync({ markReady }) {
                markReady();
                return {
                    loadSubset: async () => {
                        throw failure;
                    },
                    unloadSubset: () => {
                        releases++;
                    },
                    cleanup: () => {
                        cleanups++;
                    },
                };
            },
        },
    });
    const prepared = prepareQuery(client, (q) => q.from({ note: descriptor }));
    try {
        await expect(prepared.ready).rejects.toBe(failure);
        expect(prepared.collection.status).toBe("cleaned-up");
        await prepared.cleanup();
        expect(releases).toBeGreaterThan(0);
    } finally {
        await client.cleanup();
    }
    expect(cleanups).toBe(1);
});

test("abandoning an in-flight preparation releases native demand without waiting for its source", async () => {
    const client = new DbClient();
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
        resolve = done;
    });
    let releases = 0;
    const descriptor = collectionOptions<{ id: string }>({
        id: "abandoned-preparation",
        getKey: (row) => row.id,
        syncMode: "on-demand",
        sync: {
            sync({ markReady }) {
                markReady();
                return {
                    loadSubset: () => pending,
                    unloadSubset: () => {
                        releases++;
                    },
                };
            },
        },
    });
    const prepared = prepareQuery(client, (q) => q.from({ note: descriptor }));
    try {
        await prepared.cleanup();
        await expect(prepared.ready).rejects.toBeDefined();
        expect(prepared.collection.status).toBe("cleaned-up");
        expect(releases).toBeGreaterThan(0);
        resolve();
        await pending;
        expect(prepared.collection.status).toBe("cleaned-up");
    } finally {
        resolve();
        await prepared.cleanup();
        await client.cleanup();
    }
});
