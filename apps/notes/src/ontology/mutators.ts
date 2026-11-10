import { BackendError } from "@party-stack/ontology-backend";
import { and, eq, field } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { defaultNotebookId, deletedFolderNote } from "./folders";
import type { ActionRequest } from "@party-stack/ontology-backend";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";

export const deleteNotebook = Effect.fn("Notes.deleteNotebook")(function* (
    tx: OwnedTransaction,
    request: ActionRequest
) {
    const id = request.parameters.notebook as string;
    const folder = yield* tx.get("Notebook", id);
    if (!folder)
        return yield* new BackendError({
            operation: "deleteNotebook",
            kind: "NotFound",
            retryable: false,
            message: "Folder no longer exists.",
        });
    const fallback = defaultNotebookId(folder.ownerId as string);
    if (id === fallback)
        return yield* new BackendError({
            operation: "deleteNotebook",
            kind: "InvalidRequest",
            retryable: false,
            message: "The Notes folder cannot be deleted.",
        });
    const notes = yield* tx.loadSubset("Note", {
        where: and(eq(field("notebookId"), id), eq(field("ownerId"), folder.ownerId as string)),
    });
    const now = Temporal.Now.instant();
    for (const { key, value } of notes) {
        const changes = deletedFolderNote(fallback, value.trashed as boolean, now);
        yield* tx.patch(
            "Note",
            key,
            Object.entries(changes).map(([name, value]) => ({ path: [name], value }))
        );
    }
    yield* tx.delete("Notebook", id);
});

export const notesMutators = { deleteNotebook };
