import { createRequire } from "node:module";
import { createLiveOntology, o, type OntologyIR } from "@party-stack/ontology";
import { afterEach, describe, expect, it } from "vitest";
import { createSQLiteOntologyAdapter } from "./index.js";

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
    ],
    queryTypes: [],
};

describe("createSQLiteOntologyAdapter", () => {
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
        const adapter = createSQLiteOntologyAdapter({
            ir,
            database,
            name: "test",
        });
        const ontology = createLiveOntology({ ir, adapter });

        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
        }).mutationFn();

        const reloadedOntology = createLiveOntology({
            ir,
            adapter: createSQLiteOntologyAdapter({
                ir,
                database,
                name: "test",
            }),
        });

        const note = reloadedOntology.objects.Note!.get("note-1");
        expect(note?.title).toBe("Hello");
        expect(note?.updatedAt).toHaveProperty("epochMilliseconds");
    });

    it("stores action attachment uploads in SQLite", async () => {
        const database = createDatabase();
        const adapter = createSQLiteOntologyAdapter({
            ir,
            database,
            name: "test",
        });
        const ontology = createLiveOntology({ ir, adapter });

        await ontology.actions.createNote!({
            id: "note-1",
            title: "Hello",
        }).mutationFn();
        const attachment = await ontology.attachments!.create(
            new File(["hello attachment"], "hello.txt", { type: "text/plain" }),
            {
                target: {
                    objectType: "NoteAttachment",
                    property: "attachment",
                },
            }
        );

        await ontology.actions.createNoteAttachment!({
            id: "attachment-object-1",
            note: "note-1",
            attachment,
        }).mutationFn();

        const metadata = await ontology.attachments!.metadata(attachment);
        const blob = await ontology.attachments!.blob(attachment);

        expect(metadata).toMatchObject({
            name: "hello.txt",
            size: 16,
            type: "text/plain",
        });
        expect(await blob.text()).toBe("hello attachment");
    });
});
