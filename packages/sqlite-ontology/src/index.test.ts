import { createRequire } from "node:module";
import {
    createLiveOntology,
    o,
    type OntologyIR,
    type OntologyMutatorRegistry,
    type OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";
import { eq } from "@tanstack/db";
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
    types: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
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
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create note",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
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

describe("createSQLiteOntologyBackendAdapter", () => {
    const databases: TestDatabase[] = [];

    afterEach(() => {
        for (const database of databases.splice(0)) {
            database.close();
        }
    });

    function createDatabase() {
        const database = new Database(":memory:");
        databases.push(database);
        return database;
    }

    it("persists action mutations and hydrates Temporal values on reload", async () => {
        const database = createDatabase();
        const backendAdapter = createSQLiteOntologyBackendAdapter({
            ir,
            database,
            name: "test",
        });
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
        });

        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
        });

        const reloadedOntology = await createLiveOntology({
            ir,
            backend: (ontologyIr) =>
                createSQLiteOntologyBackendAdapter({
                    ir: ontologyIr,
                    database,
                    name: "test",
                }),
        });

        const note = reloadedOntology.objects.Note!.get("note-1");
        expect(note?.title).toBe("Hello");
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
        const database = createDatabase();
        const backendAdapter = createSQLiteOntologyBackendAdapter({
            ir,
            database,
            name: "test",
        });
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
        });

        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
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
    });
});
