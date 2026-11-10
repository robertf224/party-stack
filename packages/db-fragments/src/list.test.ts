import {
    BasicIndex,
    Query,
    createCollection,
    createLiveQueryCollection,
    eq,
    localOnlyCollectionOptions,
} from "@tanstack/db";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { defineFragment, defineListFragment, type ListFragmentData, type ListFragmentRef } from "./index.js";

test("list fragments preserve parent correlation, defaults, windows and nested row fragments", async () => {
    const folders = createCollection(
        localOnlyCollectionOptions<{ id: string }>({
            getKey: (row) => row.id,
            initialData: [{ id: "a" }, { id: "b" }],
            defaultIndexType: BasicIndex,
            autoIndex: "eager",
        })
    );
    const notes = createCollection(
        localOnlyCollectionOptions<{
            id: string;
            folder: string;
            title: string;
            rank: number;
            deleted: boolean;
        }>({
            getKey: (row) => row.id,
            initialData: [
                { id: "one", folder: "a", title: "One", rank: 1, deleted: false },
                { id: "two", folder: "a", title: "Two", rank: 2, deleted: false },
                { id: "three", folder: "b", title: "Three", rank: 3, deleted: false },
                { id: "deleted", folder: "a", title: "Deleted", rank: 0, deleted: true },
            ],
            defaultIndexType: BasicIndex,
            autoIndex: "eager",
        })
    );
    const title = defineFragment(notes, (row) => ({ title: row.title }), { key: (row) => row.id });
    const list = defineListFragment(notes, (scope, { limit = 1 }) =>
        scope
            .where(({ row }) => eq(row.deleted, false))
            .orderBy(({ row }) => row.rank, "asc")
            .limit(limit)
            .select(({ row }) => ({ id: row.id, detail: title.include(row) }))
    );
    const open = (limit?: number) =>
        createLiveQueryCollection({
            query: (q) =>
                q.from({ folder: folders }).select(({ folder }) => ({
                    id: folder.id,
                    notes: list.include(
                        new Query().from({ row: notes }).where(({ row }) => eq(row.folder, folder.id)),
                        { limit }
                    ),
                })),
        });
    const first = open();
    const expanded = open(2);
    const subscriptions = [first, expanded].map((query) => query.subscribeChanges(() => {}));
    try {
        await Promise.all([first.preload(), expanded.preload()]);
        const byFolder = (query: typeof first) =>
            Object.fromEntries(
                query.toArray.map((folder) => [folder.id, folder.notes.toArray.map((note) => note.id)])
            );
        expect(byFolder(first)).toEqual({ a: ["one"], b: ["three"] });
        expect(byFolder(expanded)).toEqual({ a: ["one", "two"], b: ["three"] });
        const ref: ListFragmentRef<typeof list> = expanded.toArray[0]!.notes;
        expectTypeOf<ListFragmentData<typeof list>["id"]>().toEqualTypeOf<string>();
        expect(ref.toArray[0]!.detail.toArray[0]!.title).toBe("One");
        await notes
            .update("one", (row) => {
                row.folder = "b";
            })
            .when("settled");
        expect(byFolder(first)).toEqual({ a: ["two"], b: ["one"] });
        expect(byFolder(expanded)).toEqual({ a: ["two"], b: ["one", "three"] });
    } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
        await Promise.all([first.cleanup(), expanded.cleanup()]);
        await notes.cleanup({ dependents: true });
        await folders.cleanup({ dependents: true });
    }
});
