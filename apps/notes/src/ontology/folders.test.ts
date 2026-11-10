import { BackendError } from "@party-stack/ontology-backend";
import { executeAction } from "@party-stack/ontology-backend/actions";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { make as memoryTables } from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { defaultNotebookId } from "./folders";
import { notesMutators, deleteNotebook } from "./mutators";
import { notesOntology } from "./ontology";

const ir = { ...notesOntology, policy: undefined };
const now = Temporal.Instant.from("2026-11-06T00:00:00Z");
const note = (id: string, notebookId = "folder") => ({
    id,
    notebookId,
    ownerId: "device",
    title: id,
    bodyMarkdown: "Keep this **Markdown**.",
    kind: "note",
    favorite: true,
    trashed: false,
    createdAt: now,
    updatedAt: now,
});

test("trashing a note clears its pin; edits and restoration do not invent a pin", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "trash-unpins",
                    tables: yield* memoryTables(),
                    ir,
                    maintenance: false,
                    mutators: { updateNote: (tx, request) => executeAction({ ir, tx, request }) },
                });
                yield* backend.storage.transaction((tx) => tx.put("Note", note("pinned")));
                yield* backend.applyAction({
                    id: "edit",
                    name: "updateNote",
                    parameters: { note: "pinned", title: "Edited" },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Note", "pinned"))).toMatchObject({
                    favorite: true,
                    title: "Edited",
                });
                yield* backend.applyAction({
                    id: "trash",
                    name: "updateNote",
                    parameters: { note: "pinned", trashed: true, favorite: true },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Note", "pinned"))).toMatchObject({
                    favorite: false,
                    trashed: true,
                });
                yield* backend.applyAction({
                    id: "restore",
                    name: "updateNote",
                    parameters: { note: "pinned", trashed: false },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Note", "pinned"))).toMatchObject({
                    favorite: false,
                    trashed: false,
                });
            })
        )
    );
});

test("editing and deleting a folder preserves its notes in trash in one journal commit", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "folders",
                    tables: yield* memoryTables(),
                    ir,
                    maintenance: false,
                    mutators: {
                        ...notesMutators,
                        updateNotebook: (tx, request) => executeAction({ ir, tx, request }),
                    },
                });
                yield* backend.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        for (const id of ["folder", "unrelated", defaultNotebookId("device")])
                            yield* tx.put("Notebook", { id, name: id, color: "#d4a72c", ownerId: "device" });
                        yield* tx.put("Note", note("regular"));
                        yield* tx.put("Note", { ...note("vault"), kind: "login" });
                        yield* tx.put("Note", { ...note("already-trashed"), trashed: true });
                        yield* tx.put("Note", note("untouched", "unrelated"));
                    })
                );
                yield* backend.applyAction({
                    id: "rename",
                    name: "updateNotebook",
                    parameters: { notebook: "folder", name: "New name", color: "#829bbc" },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Notebook", "folder"))).toMatchObject({
                    name: "New name",
                    color: "#829bbc",
                    ownerId: "device",
                });
                const before = yield* backend.loadSubset(objectSubset("Notebook"));
                yield* backend.applyAction({
                    id: "delete",
                    name: "deleteNotebook",
                    parameters: { notebook: "folder" },
                });
                expect(yield* backend.storage.read((tx) => tx.get("Notebook", "folder"))).toBeUndefined();
                for (const id of ["regular", "vault", "already-trashed"])
                    expect(yield* backend.storage.read((tx) => tx.get("Note", id))).toMatchObject({
                        notebookId: defaultNotebookId("device"),
                        trashed: true,
                        bodyMarkdown: note(id).bodyMarkdown,
                        favorite: false,
                    });
                expect(yield* backend.storage.read((tx) => tx.get("Note", "already-trashed"))).toMatchObject({
                    updatedAt: now,
                });
                expect(yield* backend.storage.read((tx) => tx.get("Note", "untouched"))).toEqual(
                    note("untouched", "unrelated")
                );
                const journal = yield* backend.changes!.pull({ cursor: before.cursor });
                expect(journal.commits).toHaveLength(1);
                expect(journal.commits[0]?.changes).toHaveLength(4);
                const protectedFolder = yield* Effect.exit(
                    backend.applyAction({
                        id: "delete-default",
                        name: "deleteNotebook",
                        parameters: { notebook: defaultNotebookId("device") },
                    })
                );
                expect(Exit.isFailure(protectedFolder)).toBe(true);
                expect(
                    yield* backend.storage.read((tx) => tx.get("Notebook", defaultNotebookId("device")))
                ).toBeDefined();
            })
        )
    );
});

test("a failure midway through folder deletion rolls back every note and the folder", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                let patched = 0;
                const backend = yield* makeOwnedBackend({
                    namespace: "rollback",
                    tables: yield* memoryTables(),
                    ir,
                    maintenance: false,
                    mutators: {
                        deleteNotebook: (tx, request) =>
                            deleteNotebook(
                                {
                                    ...tx,
                                    patch: (type, key, changes) =>
                                        ++patched === 2
                                            ? Effect.fail(
                                                  new BackendError({
                                                      operation: "test",
                                                      kind: "Unavailable",
                                                      retryable: true,
                                                      message: "Injected failure",
                                                  })
                                              )
                                            : tx.patch(type, key, changes),
                                },
                                request
                            ),
                    },
                });
                const folder = { id: "folder", name: "Keep folder", color: "#d4a72c", ownerId: "device" };
                yield* backend.storage.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put("Notebook", folder);
                        yield* tx.put("Note", note("first"));
                        yield* tx.put("Note", note("second"));
                    })
                );
                const before = yield* backend.loadSubset(objectSubset("Notebook"));
                const failed = yield* Effect.exit(
                    backend.applyAction({
                        id: "delete",
                        name: "deleteNotebook",
                        parameters: { notebook: "folder" },
                    })
                );
                expect(Exit.isFailure(failed)).toBe(true);
                expect(yield* backend.storage.read((tx) => tx.get("Notebook", "folder"))).toEqual(folder);
                for (const id of ["first", "second"])
                    expect(yield* backend.storage.read((tx) => tx.get("Note", id))).toEqual(note(id));
                expect((yield* backend.changes!.pull({ cursor: before.cursor })).commits).toEqual([]);
            })
        )
    );
});
