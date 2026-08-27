import { createRequire } from "node:module";
import {
    createLiveOntology,
    o,
    type OntologyIR,
    type OntologyMutatorRegistry,
    type OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import { eq, queryOnce } from "@tanstack/db";
import { afterEach, describe, expect, it } from "vitest";
import type { attachment as OntologyAttachment } from "@party-stack/ontology/values";
import { createSQLiteOntologyBackendAdapter } from "./index.js";

interface TestDatabase {
    close: () => void;
    exec: (sql: string) => void;
    prepare: (sql: string) => {
        all: (...params: unknown[]) => unknown[];
        get: (...params: unknown[]) => unknown;
        run: (...params: unknown[]) => unknown;
    };
    transaction: (fn: () => void) => () => void;
}

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as unknown;
const Database = BetterSqlite3 as new (path: string) => TestDatabase;

const ir: OntologyIR = {
    types: [
        {
            name: "NoteMeta",
            description: "Note metadata",
            type: o.struct({
                fields: [
                    { name: "priority", displayName: "Priority", type: o.integer({}) },
                    { name: "source", displayName: "Source", type: o.string({}) },
                ],
            }),
        },
    ],
    objectTypes: [
        {
            name: "Author",
            displayName: "Author",
            pluralDisplayName: "Authors",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "email", displayName: "Email", type: o.string({}) },
            ],
        },
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "ownerEmail", displayName: "Owner email", type: o.string({}) },
                { name: "authorId", displayName: "Author ID", type: o.string({}) },
                {
                    name: "tags",
                    displayName: "Tags",
                    type: o.list({ elementType: o.string({}) }),
                },
                {
                    name: "meta",
                    displayName: "Meta",
                    type: o.ref({ name: "NoteMeta" }),
                },
                { name: "updatedAt", displayName: "Updated at", type: o.timestamp({}) },
            ],
        },
        {
            name: "NoteAttachment",
            displayName: "Note attachment",
            pluralDisplayName: "Note attachments",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "noteId", displayName: "Note ID", type: o.string({}) },
                { name: "attachment", displayName: "Attachment", type: o.attachment({}) },
            ],
        },
    ],
    linkTypes: [
        {
            id: "note-author",
            source: { objectType: "Note", name: "notes", displayName: "Notes" },
            target: { objectType: "Author", name: "author", displayName: "Author" },
            foreignKey: "authorId",
            cardinality: "many",
        },
    ],
    actionTypes: [
        {
            name: "createAuthor",
            displayName: "Create author",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "email", displayName: "Email", type: o.string({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Author",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({ path: ["id"] }),
                        },
                        {
                            property: ["email"],
                            value: o.Expression.valueReference({ path: ["email"] }),
                        },
                    ],
                }),
            ],
        },
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                {
                    name: "ownerEmail",
                    displayName: "Owner email",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({ path: ["user", "email"] }),
                },
                {
                    name: "author",
                    displayName: "Author",
                    type: o.objectReference({ objectType: "Author" }),
                },
                {
                    name: "tags",
                    displayName: "Tags",
                    type: o.list({ elementType: o.string({}) }),
                },
                {
                    name: "meta",
                    displayName: "Meta",
                    type: o.ref({ name: "NoteMeta" }),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({ path: ["id"] }),
                        },
                        {
                            property: ["title"],
                            value: o.Expression.valueReference({ path: ["title"] }),
                        },
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.valueReference({ path: ["ownerEmail"] }),
                        },
                        {
                            property: ["authorId"],
                            value: o.Expression.valueReference({ path: ["author"] }),
                        },
                        {
                            property: ["tags"],
                            value: o.Expression.valueReference({ path: ["tags"] }),
                        },
                        {
                            property: ["meta"],
                            value: o.Expression.valueReference({ path: ["meta"] }),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
                    ],
                }),
            ],
        },
        {
            name: "createNoteAttachment",
            displayName: "Create note attachment",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({ objectType: "Note" }),
                },
                {
                    name: "attachment",
                    displayName: "Attachment",
                    type: o.attachment({}),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "NoteAttachment",
                    values: [
                        {
                            property: ["id"],
                            value: o.Expression.valueReference({ path: ["id"] }),
                        },
                        {
                            property: ["noteId"],
                            value: o.Expression.valueReference({ path: ["note"] }),
                        },
                        {
                            property: ["attachment"],
                            value: o.Expression.valueReference({ path: ["attachment"] }),
                        },
                    ],
                }),
                o.ActionLogicStep.updateObject({
                    object: { path: ["note"] },
                    values: [
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
                    ],
                }),
            ],
        },
        {
            name: "renameNote",
            displayName: "Rename note",
            parameters: [
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({
                        objectType: "Note",
                    }),
                },
                {
                    name: "title",
                    displayName: "Title",
                    type: o.string({}),
                },
            ],
            logic: [],
        },
    ],
    queryFunctionTypes: [
        {
            name: "noteTitle",
            displayName: "Note title",
            parameters: [
                {
                    name: "note",
                    displayName: "Note",
                    type: o.objectReference({
                        objectType: "Note",
                    }),
                },
            ],
            returnType: o.string({}),
        },
    ],
};

describe("SQLite LiveOntology MVP acceptance", () => {
    const databases: TestDatabase[] = [];
    const ontologies: Array<{ cleanup: () => Promise<void> }> = [];

    afterEach(async () => {
        for (const ontology of ontologies.splice(0)) {
            await ontology.cleanup();
        }
        for (const database of databases.splice(0)) {
            database.close();
        }
    });

    function createDatabase() {
        const database = new Database(":memory:");
        databases.push(database);
        return database;
    }

    async function createOntology(opts?: { context?: Record<string, unknown>; name?: string }) {
        const database = createDatabase();
        const backendAdapter = createSQLiteOntologyBackendAdapter({
            ir,
            database,
            name: opts?.name ?? "test",
        });
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            context: opts?.context,
        });
        ontologies.push(ontology);
        return { database, ontology };
    }

    async function readObjectById(
        collection: { get: (id: string) => unknown },
        primaryKey: string,
        id: string
    ) {
        await queryOnce((q) =>
            q
                .from({ object: collection as never })
                .where(({ object }) => eq((object as Record<string, unknown>)[primaryKey], id))
                .select(({ object }) => object)
        );
        return collection.get(id);
    }

    it("supports primitive, struct, list, object-reference, and defaultValue parameters", async () => {
        const { ontology } = await createOntology({
            context: { user: { email: "alice@example.com" } },
        });
        await ontology.ready;

        await ontology.actions.createAuthor!({
            id: "author-1",
            email: "author@example.com",
        });
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
            author: "author-1",
            tags: ["mvp", "sqlite"],
            meta: { priority: 2, source: "demo" },
        });

        const note = (await readObjectById(ontology.objects.Note!, "id", "note-1")) as Record<
            string,
            unknown
        >;
        expect(note).toMatchObject({
            id: "note-1",
            title: "Hello",
            ownerEmail: "alice@example.com",
            authorId: "author-1",
            tags: ["mvp", "sqlite"],
            meta: { priority: 2, source: "demo" },
        });
        expect(note.updatedAt).toHaveProperty("epochMilliseconds");
        expect(
            ((await readObjectById(ontology.objects.Author!, "id", "author-1")) as { email: string })
                .email
        ).toBe("author@example.com");
        expect(ir.linkTypes[0]).toMatchObject({
            foreignKey: "authorId",
            cardinality: "many",
        });
    });

    it("persists action mutations and hydrates Temporal values on reload", async () => {
        const { database, ontology } = await createOntology({
            context: { user: { email: "alice@example.com" } },
        });
        await ontology.ready;

        await ontology.actions.createAuthor!({
            id: "author-1",
            email: "author@example.com",
        });
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
            author: "author-1",
            tags: ["reload"],
            meta: { priority: 1, source: "persist" },
        });
        await ontology.cleanup();
        ontologies.splice(ontologies.indexOf(ontology), 1);

        const reloadedOntology = await createLiveOntology({
            ir,
            backend: (ontologyIr) =>
                createSQLiteOntologyBackendAdapter({
                    ir: ontologyIr,
                    database,
                    name: "test",
                }),
            context: { user: { email: "alice@example.com" } },
        });
        ontologies.push(reloadedOntology);
        await reloadedOntology.ready;

        const note = reloadedOntology.objects.Note!.get("note-1");
        expect(note?.title).toBe("Hello");
        expect(note?.tags).toEqual(["reload"]);
        expect(note?.meta).toEqual({ priority: 1, source: "persist" });
        expect(note?.updatedAt).toHaveProperty("epochMilliseconds");
    });

    it("executes shared mutators and query function handlers authoritatively", async () => {
        const database = createDatabase();
        const mutators = {
            renameNote: async ({
                tx,
                args,
            }) => {
                await tx.mutate.Note!.update(
                    args.note as string,
                    {
                        title:
                            args.title,
                    }
                );
            },
        } satisfies OntologyMutatorRegistry;
        const queryFunctions = {
            noteTitle: async ({
                tx,
                args,
            }) => {
                const note = await tx.query<{
                    title: unknown;
                } | undefined>(
                    (query, objects) =>
                    query
                        .from({
                            note: objects.Note!,
                        })
                        .where(({ note }) =>
                            eq(
                                note.id,
                                args.note
                            )
                        )
                        .select(
                            ({ note }) => ({
                                title:
                                    note.title,
                            })
                        )
                        .findOne()
                );
                return note?.title;
            },
        } satisfies OntologyQueryFunctionRegistry;
        const ontology =
            await createLiveOntology({
                ir,
                backend: () =>
                    createSQLiteOntologyBackendAdapter(
                        {
                            ir,
                            database,
                            name: "handlers",
                            mutators,
                            queryFunctions,
                        }
                    ),
            });

        await ontology.actions.createNote!({
            id: "note-1",
            title: "Before",
        });
        await ontology.actions.renameNote!({
            note: "note-1",
            title: "After",
        });

        await expect(
            ontology.queryFunctions.noteTitle!(
                {
                    note: "note-1",
                }
            )
        ).resolves.toBe("After");
        expect(
            ontology.objects.Note!.get(
                "note-1"
            )?.title
        ).toBe("After");
        await ontology.cleanup();
    });

    it("rejects non-declarative actions without a mutator", async () => {
        const database = createDatabase();
        const ontology =
            await createLiveOntology({
                ir,
                backend: () =>
                    createSQLiteOntologyBackendAdapter(
                        {
                            ir,
                            database,
                            name: "missing-mutator",
                        }
                    ),
            });

        await expect(
            ontology.actions.renameNote!({
                note: "note-1",
                title: "After",
            })
        ).rejects.toThrow(
            'SQLite ontology adapter cannot apply non-declarative action type "renameNote" without a registered mutator.'
        );
        await ontology.cleanup();
    });

    it("stores action attachment uploads in SQLite", async () => {
        const { ontology } = await createOntology({
            context: { user: { email: "alice@example.com" } },
        });
        await ontology.ready;

        await ontology.actions.createAuthor!({
            id: "author-1",
            email: "author@example.com",
        });
        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
            author: "author-1",
            tags: [],
            meta: { priority: 0, source: "attachment" },
        });
        const creation = await ontology.attachments.create(
            new File(["hello attachment"], "hello.txt", { type: "text/plain" }),
            {
                target: {
                    kind: "objectProperty",
                    objectType: "NoteAttachment",
                    property: "attachment",
                },
            }
        );
        const attachment = creation.attachment as unknown as OntologyAttachment;

        await ontology.actions.createNoteAttachment!({
            id: "attachment-object-1",
            note: "note-1",
            attachment,
        });

        const metadata = await ontology.attachments.metadata(attachment);
        const blob = await ontology.attachments.blob(attachment);

        expect(metadata).toMatchObject({
            name: "hello.txt",
            size: 16,
            type: "text/plain",
        });
        expect(await blob.text()).toBe("hello attachment");
        expect(
            (
                (await readObjectById(
                    ontology.objects.NoteAttachment!,
                    "id",
                    "attachment-object-1"
                )) as { noteId: string }
            ).noteId
        ).toBe("note-1");
    });

    it("supports safe initialization and idempotent cleanup", async () => {
        const { ontology } = await createOntology({
            context: { user: { email: "alice@example.com" } },
        });
        await ontology.ready;
        await ontology.cleanup();
        await expect(ontology.cleanup()).resolves.toBeUndefined();
    });
});
