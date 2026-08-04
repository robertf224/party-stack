import { eq, queryOnce } from "@tanstack/db";
import { describe, expect, it } from "vitest";
import blog from "../examples/blog.js";
import { o } from "../ir/index.js";
import { createStaticMetaOntologyBackend } from "./createStaticMetaOntologyBackend.js";
import { createMetaLiveOntology } from "./generated/live.js";
import { pull } from "./pull.js";
import type { OntologyIR } from "../ir/index.js";

const fixtureIr: OntologyIR = {
    types: [
        {
            name: "Address",
            type: o.struct({
                fields: [{ name: "city", displayName: "City", type: o.string({}) }],
            }),
        },
        {
            name: "UnusedType",
            type: o.string({}),
        },
    ],
    objectTypes: [
        {
            name: "Author",
            id: "ri.ontology.main.object-type.author",
            displayName: "Author",
            pluralDisplayName: "Authors",
            primaryKey: "authorId",
            titleProperty: "name",
            properties: [
                { name: "authorId", displayName: "Author ID", type: o.string({}) },
                { name: "name", displayName: "Name", type: o.string({}) },
                {
                    name: "address",
                    displayName: "Address",
                    type: o.optional({ type: o.ref({ name: "Address" }) }),
                },
            ],
        },
        {
            name: "Post",
            id: "ri.ontology.main.object-type.post",
            displayName: "Post",
            pluralDisplayName: "Posts",
            primaryKey: "postId",
            titleProperty: "title",
            properties: [
                { name: "postId", displayName: "Post ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "authorId", displayName: "Author ID", type: o.string({}) },
            ],
        },
        {
            name: "Orphan",
            displayName: "Orphan",
            pluralDisplayName: "Orphans",
            primaryKey: "id",
            properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
        },
    ],
    linkTypes: [
        {
            id: "Post:author",
            source: { objectType: "Post", name: "posts", displayName: "Posts", cardinality: "many" },
            target: {
                objectType: "Author",
                name: "author",
                displayName: "Author",
                cardinality: "one",
            },
            foreignKey: "authorId",
            cardinality: "many",
        },
        {
            id: "Orphan:self",
            source: { objectType: "Orphan", name: "orphans", displayName: "Orphans" },
            target: { objectType: "Orphan", name: "self", displayName: "Self" },
            foreignKey: "id",
            cardinality: "one",
        },
    ],
    actionTypes: [
        {
            name: "createPost",
            id: "ri.actions.main.action-type.create-post",
            displayName: "Create Post",
            parameters: [
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
                {
                    name: "author",
                    displayName: "Author",
                    type: o.objectReference({ objectType: "Author" }),
                },
            ],
            logic: [
                {
                    kind: "createObject",
                    value: {
                        objectType: "Post",
                        values: [
                            {
                                property: ["title"],
                                value: {
                                    kind: "valueReference",
                                    value: { path: ["title"] },
                                },
                            },
                        ],
                    },
                },
            ],
        },
        {
            name: "unusedAction",
            displayName: "Unused",
            parameters: [],
            logic: [],
        },
    ],
    queryFunctionTypes: [
        {
            name: "searchPosts",
            displayName: "Search Posts",
            parameters: [{ name: "query", displayName: "Query", type: o.string({}) }],
            returnType: o.list({ elementType: o.ref({ name: "Address" }) }),
        },
        {
            name: "unusedQuery",
            displayName: "Unused Query",
            parameters: [],
            returnType: o.string({}),
        },
    ],
};

describe("createStaticMetaOntologyBackend + pull", () => {
    it("exposes meta collections that preserve ids and title properties", async () => {
        const meta = await createMetaLiveOntology({
            backend: createStaticMetaOntologyBackend({ ir: fixtureIr }),
            persistObjects: false,
            writes: { defaultMode: "direct" },
        });

        try {
            const objectType = await queryOnce((q) =>
                q
                    .from({ ObjectType: meta.objects.ObjectType })
                    .where(({ ObjectType }) => eq(ObjectType.id, "ri.ontology.main.object-type.author"))
                    .findOne()
            );
            expect(objectType).toMatchObject({
                name: "Author",
                id: "ri.ontology.main.object-type.author",
                titleProperty: "name",
            });

            const actionType = await queryOnce((q) =>
                q
                    .from({ ActionType: meta.objects.ActionType })
                    .where(({ ActionType }) =>
                        eq(ActionType.id, "ri.actions.main.action-type.create-post")
                    )
                    .findOne()
            );
            expect(actionType).toMatchObject({
                name: "createPost",
                id: "ri.actions.main.action-type.create-post",
            });
        } finally {
            await meta.cleanup();
        }
    });

    it("pulls a scoped OntologyIR including transitive value types and links", async () => {
        const meta = await createMetaLiveOntology({
            backend: createStaticMetaOntologyBackend({ ir: fixtureIr }),
            persistObjects: false,
            writes: { defaultMode: "direct" },
        });

        try {
            const pulled = await pull(meta, {
                objectTypeNames: ["Author", "Post"],
                actionTypeNames: ["createPost"],
                queryFunctionTypeNames: ["searchPosts"],
            });

            expect(pulled.objectTypes.map((objectType) => objectType.name).sort()).toEqual([
                "Author",
                "Post",
            ]);
            expect(pulled.objectTypes.find((objectType) => objectType.name === "Author")).toMatchObject({
                id: "ri.ontology.main.object-type.author",
                titleProperty: "name",
            });
            expect(pulled.linkTypes.map((linkType) => linkType.id)).toEqual(["Post:author"]);
            expect(pulled.actionTypes).toHaveLength(1);
            expect(pulled.actionTypes[0]).toMatchObject({
                name: "createPost",
                id: "ri.actions.main.action-type.create-post",
            });
            expect(pulled.queryFunctionTypes.map((query) => query.name)).toEqual(["searchPosts"]);
            expect(pulled.types.map((type) => type.name).sort()).toEqual(["Address"]);
        } finally {
            await meta.cleanup();
        }
    });

    it("supports empty selections and rejects writes", async () => {
        const meta = await createMetaLiveOntology({
            backend: createStaticMetaOntologyBackend({ ir: fixtureIr }),
            persistObjects: false,
            writes: { defaultMode: "direct" },
        });

        try {
            await expect(
                pull(meta, {
                    objectTypeNames: [],
                    actionTypeNames: [],
                    queryFunctionTypeNames: [],
                })
            ).resolves.toEqual({
                types: [],
                objectTypes: [],
                linkTypes: [],
                actionTypes: [],
                queryFunctionTypes: [],
            });

            expect(meta.actions).toBeDefined();
            const backend = createStaticMetaOntologyBackend({ ir: fixtureIr });
            const adapter = await backend(fixtureIr, {});
            await expect(adapter.applyAction("noop", {}, { objects: {} })).rejects.toThrow(/read-only/);
            await expect(adapter.runQueryFunction("noop", {}, { objects: {} })).rejects.toThrow(
                /read-only/
            );
        } finally {
            await meta.cleanup();
        }
    });

    it("works with the blog example ontology", async () => {
        const meta = await createMetaLiveOntology({
            backend: createStaticMetaOntologyBackend({ ir: blog }),
            persistObjects: false,
            writes: { defaultMode: "direct" },
        });

        try {
            const pulled = await pull(meta, {
                objectTypeNames: ["Author", "Post", "Comment"],
                actionTypeNames: ["createPost"],
                queryFunctionTypeNames: [],
            });
            expect(pulled.objectTypes).toHaveLength(3);
            expect(pulled.linkTypes.length).toBeGreaterThan(0);
            expect(pulled.types.map((type) => type.name)).toContain("Address");
        } finally {
            await meta.cleanup();
        }
    });
});
