import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { BasicIndex, createCollection } from "@tanstack/db";
import {
    createNodeSQLitePersistence,
    persistedCollectionOptions,
} from "@tanstack/node-db-sqlite-persistence";
import type { OntologyAdapter, OntologyCollectionOptions } from "@party-stack/ontology";
import { notesOntology, type Note } from "./notesOntology.js";

export interface NotesContext {
    user: {
        email: string;
    };
}

mkdirSync("temp", { recursive: true });

const database = new Database("temp/remote-notes.sqlite");
const persistence = createNodeSQLitePersistence({ database });

function createNoteCollectionOptions() {
    return persistedCollectionOptions<Note, string>({
        id: "notes",
        getKey: (note) => note.id,
        persistence,
        schemaVersion: 1,
        defaultIndexType: BasicIndex,
        autoIndex: "eager",
    });
}

const notesCollection = createCollection(createNoteCollectionOptions());

let preloadPromise: Promise<void> | undefined;

function preloadNotes(): Promise<void> {
    preloadPromise ??= notesCollection.preload();
    return preloadPromise;
}

async function getNote(id: string): Promise<Note | undefined> {
    await preloadNotes();
    return notesCollection.get(id) as Note | undefined;
}

export async function userOwnsNote(email: string, noteId: string): Promise<boolean> {
    const note = await getNote(noteId);
    return note?.ownerEmail === email;
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string") {
        throw new Error(`Expected "${name}" to be a string.`);
    }
    return value;
}

async function persistTransaction(transaction: { isPersisted: { promise: Promise<unknown> } }) {
    await transaction.isPersisted.promise;
}

export const notesAdapter: OntologyAdapter = {
    name: "remote-notes-sqlite",
    getCollectionOptions: (objectType): OntologyCollectionOptions => {
        if (objectType !== "Note") {
            throw new Error(`Unknown object type "${objectType}".`);
        }

        const { getKey: _getKey, ...options } = createNoteCollectionOptions();
        return options as unknown as OntologyCollectionOptions;
    },
    applyAction: async (actionType, parameters) => {
        await preloadNotes();

        switch (actionType) {
            case "createNote": {
                const now = new Date().toISOString();
                const note: Note = {
                    id: requireString(parameters.id, "id"),
                    ownerEmail: requireString(parameters.ownerEmail, "ownerEmail"),
                    title: requireString(parameters.title, "title"),
                    bodyMarkdown: requireString(parameters.bodyMarkdown, "bodyMarkdown"),
                    createdAt:
                        typeof parameters.createdAt === "string" ? parameters.createdAt : now,
                    updatedAt:
                        typeof parameters.updatedAt === "string" ? parameters.updatedAt : now,
                };
                await persistTransaction(notesCollection.insert(note));
                break;
            }
            case "updateNote": {
                const noteId = requireString(parameters.note, "note");
                const updatedAt =
                    typeof parameters.updatedAt === "string"
                        ? parameters.updatedAt
                        : new Date().toISOString();

                await persistTransaction(
                    notesCollection.update(noteId, (draft) => {
                        if (typeof parameters.title === "string") {
                            draft.title = parameters.title;
                        }
                        if (typeof parameters.bodyMarkdown === "string") {
                            draft.bodyMarkdown = parameters.bodyMarkdown;
                        }
                        draft.updatedAt = updatedAt;
                    })
                );
                break;
            }
            case "deleteNote": {
                await persistTransaction(notesCollection.delete(requireString(parameters.note, "note")));
                break;
            }
            default:
                throw new Error(`Unknown action "${actionType}".`);
        }
    },
};

export { notesOntology };
