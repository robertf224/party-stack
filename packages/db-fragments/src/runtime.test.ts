import {
    BasicIndex,
    collectionOptions,
    DbClient,
    Query,
    createCollection,
    createLiveQueryCollection,
    eq,
    gte,
    lte,
    localOnlyCollectionOptions,
    prepareLiveQueryValue,
} from "@tanstack/db";
import { expect, test } from "vite-plus/test";
import { initialListQuery, listRecipe } from "./runtime.js";
import { defineFragment, defineListFragment } from "./index.js";

test("nested lists re-root original sources, including empty routes and unselected parent filters", async () => {
    const folders = createCollection(
        localOnlyCollectionOptions({
            getKey: (row: { id: string; minimum: number }) => row.id,
            initialData: [
                { id: "a", minimum: 2 },
                { id: "b", minimum: 1 },
                { id: "empty", minimum: 0 },
            ],
            autoIndex: "eager",
            defaultIndexType: BasicIndex,
        })
    );
    const notes = createCollection(
        localOnlyCollectionOptions({
            getKey: (row: { id: string; folder: string; rank: number; text: string }) => row.id,
            initialData: Array.from({ length: 5 }, (_, i) =>
                ["a", "b"].map((folder) => ({
                    id: `${folder}${i + 1}`,
                    folder,
                    rank: i + 1,
                    text: `${folder} ${i + 1}`,
                }))
            ).flat(),
            autoIndex: "eager",
            defaultIndexType: BasicIndex,
        })
    );
    const badge = defineFragment(notes, (row) => ({ text: row.text }), { key: (row) => row.id });
    const list = defineListFragment(notes, (scope, { limit = 2 }) =>
        scope
            .orderBy(({ row }) => row.rank)
            .limit(limit)
            .select(({ row }) => ({ id: row.id, badge: badge.include(row) }))
    );
    const card = defineFragment(
        folders,
        (folder) => ({
            // Parent id/minimum and the child's rank are intentionally not selected.
            notes: list.include(
                new Query()
                    .from({ row: notes })
                    .where(({ row }) => eq(row.folder, folder.id))
                    .where(({ row }) => gte(row.rank, folder.minimum))
            ),
        }),
        { key: (row) => row.id }
    );
    const parent = createLiveQueryCollection({
        query: (q) =>
            q
                .from({ folder: folders })
                .select(({ folder }) => ({ id: folder.id, card: card.include(folder) })),
    });
    const roots: ReturnType<typeof createLiveQueryCollection>[] = [];
    try {
        await parent.preload();
        const ref = (id: string) => parent.toArray.find((row) => row.id === id)!.card.toArray[0]!.notes;
        const originalA = ref("a");
        const open = (id: string) => {
            const recipe = listRecipe(ref(id));
            expect(recipe?.pageSize).toBe(2);
            const root = createLiveQueryCollection({ query: initialListQuery(recipe!.query) });
            roots.push(root);
            return root;
        };
        const a = open("a"),
            b = open("b"),
            empty = open("empty");
        await Promise.all(roots.map((root) => root.preload()));
        expect(a.toArray.map((row) => row.id)).toEqual(["a2", "a3", "a4"]);
        expect(b.toArray.map((row) => row.id)).toEqual(["b1", "b2", "b3"]);
        expect(empty.size).toBe(0);
        await a.utils.setWindow({ offset: 0, limit: 5 });
        expect(a.toArray.map((row) => row.id)).toEqual(["a2", "a3", "a4", "a5"]);
        expect(b.size).toBe(3);
        expect(originalA.size).toBe(2);
        expect(a.toArray[0]!.badge.toArray[0]!.text).toBe("a 2");
        await notes.insert({ id: "empty1", folder: "empty", rank: 1, text: "New" }).when("settled");
        expect(empty.toArray.map((row) => row.id)).toEqual(["empty1"]);
        await notes
            .update("a2", (row) => {
                row.folder = "b";
            })
            .when("settled");
        expect(a.toArray.map((row) => row.id)).toEqual(["a3", "a4", "a5"]);
        expect(b.toArray.map((row) => row.id)).toEqual(["b1", "a2", "b2"]);
        await folders
            .update("a", (row) => {
                row.minimum = 4;
            })
            .when("settled");
        const rebound = open("a");
        await rebound.preload();
        expect(rebound.toArray.map((row) => row.id)).toEqual(["a4", "a5"]);
    } finally {
        await Promise.all(roots.map((root) => root.cleanup()));
        await parent.cleanup();
        await notes.cleanup({ dependents: true });
        await folders.cleanup({ dependents: true });
    }
});

test("descriptor lists preserve client isolation and identically named nested includes", async () => {
    const folders = collectionOptions("folders", () =>
        localOnlyCollectionOptions({
            id: "folders",
            getKey: (row: { id: string; low: number; high: number }) => row.id,
            initialData: [{ id: "a", low: 2, high: 3 }],
            autoIndex: "eager",
            defaultIndexType: BasicIndex,
        })
    );
    const notes = collectionOptions("notes", (client) =>
        localOnlyCollectionOptions({
            id: "notes",
            getKey: (row: { id: string; folder: string; rank: number; title: string }) => row.id,
            initialData: [1, 2, 3, 4].map((rank) => ({
                id: `${rank}`,
                folder: "a",
                rank,
                title: `${client.requireDependency<string>("prefix")}${rank}`,
            })),
            autoIndex: "eager",
            defaultIndexType: BasicIndex,
        })
    );
    const list = defineListFragment(notes, (scope, { limit = 1 }) =>
        scope
            .orderBy(({ row }) => row.rank)
            .limit(limit)
            .select(({ row }) => ({ title: row.title }))
    );
    const low = defineFragment(
        folders,
        (row) => ({
            list: list.include(
                new Query()
                    .from({ row: notes })
                    .where(({ row: note }) => eq(note.folder, row.id))
                    .where(({ row: note }) => gte(note.rank, row.low))
            ),
        }),
        { key: (row) => row.id }
    );
    const high = defineFragment(
        folders,
        (row) => ({
            list: list.include(
                new Query()
                    .from({ row: notes })
                    .where(({ row: note }) => eq(note.folder, row.id))
                    .where(({ row: note }) => lte(note.rank, row.high))
            ),
        }),
        { key: (row) => row.id }
    );
    const clients = [new DbClient({ prefix: "First " }), new DbClient({ prefix: "Second " })];
    const queries = clients.map((client) => {
        const query = new Query()
            .from({ row: folders })
            .select(({ row }) => ({ low: low.include(row), high: high.include(row) }));
        return createLiveQueryCollection({ query: prepareLiveQueryValue(query, client) as typeof query });
    });
    const roots: ReturnType<typeof createLiveQueryCollection>[] = [];
    try {
        await Promise.all(queries.map((query) => query.preload()));
        for (const [i, parent] of queries.entries()) {
            const refs = parent.toArray[0]!;
            for (const [ref, expected] of [
                [refs.low.toArray[0]!.list, ["2", "3", "4"]],
                [refs.high.toArray[0]!.list, ["1", "2", "3"]],
            ] as const) {
                const recipe = listRecipe(ref)!;
                const query = initialListQuery(recipe.query);
                const root = createLiveQueryCollection({
                    query: prepareLiveQueryValue(query, clients[i]!) as typeof query,
                });
                roots.push(root);
                await root.preload();
                await root.utils.setWindow({ offset: 0, limit: 5 });
                expect(root.toArray.map((row) => row.title)).toEqual(
                    expected.map((id) => `${i === 0 ? "First" : "Second"} ${id}`)
                );
            }
        }
    } finally {
        await Promise.all(roots.map((root) => root.cleanup()));
        await Promise.all(queries.map((query) => query.cleanup()));
        await Promise.all(clients.map((client) => client.cleanup()));
    }
});
