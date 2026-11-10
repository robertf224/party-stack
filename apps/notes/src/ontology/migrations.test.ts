import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { make as memoryTables } from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { migrateNoteDocuments, migrateNotesReplica, migrateNotesStorage } from "./migrations";
import { notesOntology } from "./ontology";
import type { OntologyIR } from "@party-stack/ontology";

const current = { ...notesOntology, policy: undefined };
const beforeTrashUnpins: OntologyIR = {
    ...current,
    actionTypes: current.actionTypes.map((action) =>
        action.name === "updateNote"
            ? {
                  ...action,
                  logic: [
                      {
                          kind: "updateObject",
                          value: {
                              object: { name: "note" },
                              values: [
                                  ...[
                                      "title",
                                      "bodyMarkdown",
                                      "notebookId",
                                      "favorite",
                                      "trashed",
                                      "secret",
                                  ].map((name) => ({
                                      property: [name],
                                      value: { kind: "inputReference" as const, value: { name } },
                                  })),
                                  { property: ["updatedAt"], value: { kind: "now", value: {} } },
                              ],
                          },
                      },
                  ],
              }
            : action
    ),
};
const beforeAppearance: OntologyIR = {
    ...beforeTrashUnpins,
    objectTypes: current.objectTypes.map((type) => {
        const previous = {
            ...type,
            color:
                type.name === "Preferences"
                    ? "#9aa8b5"
                    : type.name === "NoteAttachment"
                      ? "#8b9cc4"
                      : "#d4a72c",
        };
        delete previous.icon;
        return previous;
    }),
};
const beforeFolders: OntologyIR = {
    ...beforeAppearance,
    actionTypes: beforeTrashUnpins.actionTypes.filter(
        ({ name }) => name !== "updateNotebook" && name !== "deleteNotebook"
    ),
};
const previous: OntologyIR = {
    ...beforeFolders,
    objectTypes: beforeFolders.objectTypes.filter(({ name }) => name !== "Preferences"),
    actionTypes: beforeFolders.actionTypes.filter(({ name }) => name !== "setPanelWidths"),
};

test("whole-document migration preserves plain titles, Markdown and vault labels exactly once", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* memoryTables();
                const backend = yield* makeOwnedBackend({
                    namespace: "documents",
                    tables,
                    ir: current,
                    maintenance: false,
                    mutators: {},
                });
                const now = Temporal.Now.instant();
                const note = {
                    id: "document",
                    ownerId: "device",
                    notebookId: "device:personal",
                    title: "# Plan *carefully* [today]",
                    bodyMarkdown: "## Details\n\n**Keep** this.\n\n![photo](attachment:photo)",
                    kind: "note",
                    favorite: false,
                    trashed: false,
                    createdAt: now,
                    updatedAt: now,
                };
                yield* backend.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("Note", note);
                        yield* tx.put("Note", { ...note, id: "vault", kind: "secure" });
                    })
                );
                // Failure after row conversion must roll back both the document
                // and marker; a retry must not prepend the label a second time.
                const failed = yield* Effect.exit(
                    migrateNoteDocuments(backend.storage, {
                        ...tables,
                        put: () => Effect.die(new Error("Interrupted before migration marker")),
                    })
                );
                expect(Exit.isFailure(failed)).toBe(true);
                expect(yield* backend.storage.read((tx) => tx.get("Note", note.id))).toEqual(note);
                yield* migrateNoteDocuments(backend.storage, tables);
                const converted = yield* backend.storage.read((tx) => tx.get("Note", note.id));
                expect(converted).toEqual({
                    ...note,
                    bodyMarkdown: "\\# Plan \\*carefully\\* \\[today\\]\n\n" + note.bodyMarkdown,
                });
                expect(yield* backend.storage.read((tx) => tx.get("Note", "vault"))).toEqual({
                    ...note,
                    id: "vault",
                    kind: "secure",
                });
                yield* migrateNoteDocuments(backend.storage, tables);
                expect(yield* backend.storage.read((tx) => tx.get("Note", note.id))).toEqual(converted);
            })
        )
    );
});

test("adding Preferences reopens existing object storage without replacing its data or journal", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* memoryTables();
                const options = { namespace: "notes-v1", tables, maintenance: false as const, mutators: {} };
                const folder = { id: "device:work", ownerId: "device", name: "Work", color: "#829bbc" };
                const original = yield* makeOwnedBackend({ ...options, ir: previous });
                yield* original.storage.transaction((tx) => tx.put("Notebook", folder));
                const head = yield* tables.get(
                    Table.make({ name: JSON.stringify(["backend", options.namespace, "metadata"]) }),
                    "head"
                );
                yield* migrateNotesStorage(tables, options.namespace);
                const updated = yield* makeOwnedBackend({ ...options, ir: current });
                expect(yield* updated.storage.read((tx) => tx.get("Notebook", folder.id))).toEqual(folder);
                yield* updated.storage.transaction((tx) =>
                    tx.put("Preferences", {
                        id: "device",
                        ownerId: "device",
                        foldersWidth: 230,
                        notesWidth: 340,
                    })
                );
                yield* migrateNotesStorage(tables, options.namespace);
                expect(yield* updated.storage.read((tx) => tx.get("Preferences", "device"))).toMatchObject({
                    foldersWidth: 230,
                });
                expect(
                    yield* tables.get(
                        Table.make({ name: JSON.stringify(["backend", options.namespace, "metadata"]) }),
                        "head"
                    )
                ).toEqual(head);
            })
        )
    );
});

test("replica migration keeps queued actions, cached objects and sequence/cursor state, and rejects unrelated changes", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* memoryTables();
            const position = Table.make<{
                signature: string;
                sequence: number;
                cursor: string;
                source: string;
            }>({ name: JSON.stringify(["replica", "notes-v1", "position"]) });
            const outbox = Table.make({ name: JSON.stringify(["replica", "notes-v1", "outbox"]) });
            const head = {
                signature: ontologyDefinitionSignature(previous),
                sequence: 42,
                cursor: "existing-cursor",
                source: "existing-source",
            };
            const queued = {
                id: "unsent-edit",
                name: "updateNote",
                parameters: { note: "my-note", title: "Keep this edit" },
            };
            yield* tables.put(position, "head", head);
            yield* tables.put(outbox, queued.id, queued);
            yield* migrateNotesReplica(tables, "notes-v1", current);
            yield* migrateNotesReplica(tables, "notes-v1", current);
            expect(yield* tables.get(position, "head")).toEqual({
                ...head,
                signature: ontologyDefinitionSignature(current),
            });
            expect(yield* tables.get(outbox, queued.id)).toEqual(queued);
            yield* tables.put(position, "head", {
                ...head,
                signature: ontologyDefinitionSignature(beforeFolders),
            });
            yield* migrateNotesReplica(tables, "notes-v1", current);
            expect(yield* tables.get(position, "head")).toEqual({
                ...head,
                signature: ontologyDefinitionSignature(current),
            });
            expect(yield* tables.get(outbox, queued.id)).toEqual(queued);
            yield* tables.put(position, "head", {
                ...head,
                signature: ontologyDefinitionSignature(beforeAppearance),
            });
            yield* migrateNotesReplica(tables, "notes-v1", current);
            expect(yield* tables.get(position, "head")).toEqual({
                ...head,
                signature: ontologyDefinitionSignature(current),
            });
            expect(yield* tables.get(outbox, queued.id)).toEqual(queued);
            yield* tables.put(position, "head", {
                ...head,
                signature: ontologyDefinitionSignature(beforeTrashUnpins),
            });
            yield* migrateNotesReplica(tables, "notes-v1", current);
            expect(yield* tables.get(position, "head")).toEqual({
                ...head,
                signature: ontologyDefinitionSignature(current),
            });
            expect(yield* tables.get(outbox, queued.id)).toEqual(queued);
            yield* tables.put(position, "head", { ...head, signature: "unrelated-definition" });
            const result = yield* Effect.exit(migrateNotesReplica(tables, "notes-v1", current));
            expect(Exit.isFailure(result)).toBe(true);
            expect((yield* tables.get(position, "head"))?.signature).toBe("unrelated-definition");
        })
    );
});
