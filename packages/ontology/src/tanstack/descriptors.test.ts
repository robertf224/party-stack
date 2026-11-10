import {
    BasicIndex,
    DbClient,
    Query,
    createLiveQueryCollection,
    include,
    isCollectionOptions,
    localOnlyCollectionOptions,
    prepareLiveQueryValue,
} from "@tanstack/db";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { ontologyCollections } from "./descriptors.js";
import type { OntologyDefinition } from "@party-stack/ontology-spec";

interface Definition extends OntologyDefinition {
    objectTypes: { Article: { slug: string; title: string } };
}

test("descriptors carry explicit primary keys without acquiring a client or rows", () => {
    const { objects, cachedObjects } = ontologyCollections<Definition>({ Article: "slug" });
    expect(objects.Article.primaryKey).toBe("slug");
    expect(cachedObjects.Article.primaryKey).toBe("slug");
    expect(objects.Article).toBe(objects.Article);
    expect(objects.Article).not.toBe(cachedObjects.Article);
    expect(Object.isFrozen(objects.Article)).toBe(true);
    expect(isCollectionOptions(objects.Article)).toBe(true);
    expectTypeOf(objects.Article.primaryKey).toEqualTypeOf<"slug" | "title">();
});

test("descriptor links follow both directions and nested self-links in the consuming client", async () => {
    interface LinkedDefinition extends OntologyDefinition {
        objectTypes: {
            Folder: { id: string };
            Note: { id: string; folderId: string; title: string; parent?: { id: string } };
        };
    }
    const metadata = {
        Folder: { notes: { objectType: "Note", source: ["id"], target: ["folderId"] } },
        Note: {
            folder: { objectType: "Folder", source: ["folderId"], target: ["id"] },
            parent: { objectType: "Note", source: ["parent", "id"], target: ["id"] },
        },
    } as const;
    const { objects } = ontologyCollections<LinkedDefinition, typeof metadata>(
        { Folder: "id", Note: "id" },
        metadata
    );
    const client = new DbClient({
        "@party-stack/ontology/collectionOptions": (id: string, type: string) =>
            localOnlyCollectionOptions({
                id,
                getKey: (row: { id: string }) => row.id,
                initialData:
                    type === "Folder"
                        ? [{ id: "a" }, { id: "b" }]
                        : [
                              { id: "one", folderId: "a", title: "One", parent: { id: "two" } },
                              { id: "two", folderId: "b", title: "Two", parent: { id: "two" } },
                          ],
                autoIndex: "eager",
                defaultIndexType: BasicIndex,
            }),
    });
    const query = new Query().from({ folder: objects.Folder }).select(({ folder }) => ({
        id: folder.id,
        notes: include(
            objects.Folder.links
                .notes(folder)
                .orderBy(({ row }) => row.id)
                .select(({ row }) => ({
                    id: row.id,
                    folder: include(objects.Note.links.folder(row).select(({ row }) => ({ id: row.id }))),
                    parent: include(
                        objects.Note.links.parent(row).select(({ row }) => ({ title: row.title }))
                    ),
                }))
        ),
    }));
    const output = createLiveQueryCollection({ query: prepareLiveQueryValue(query, client) as typeof query });
    const subscription = output.subscribeChanges(() => {});
    try {
        await output.preload();
        const first = output.toArray.find((row) => row.id === "a")!.notes.toArray[0]!;
        expect(first.folder.toArray).toMatchObject([{ id: "a" }]);
        expect(first.parent.toArray).toMatchObject([{ title: "Two" }]);
        await client
            .collection(objects.Note)
            .update("one", (row) => {
                row.folderId = "b";
            })
            .when("settled");
        expect(output.toArray.find((row) => row.id === "a")!.notes.size).toBe(0);
        expect(output.toArray.find((row) => row.id === "b")!.notes.toArray.map((row) => row.id)).toEqual([
            "one",
            "two",
        ]);
    } finally {
        subscription.unsubscribe();
        await output.cleanup();
        await client.cleanup();
    }
});
