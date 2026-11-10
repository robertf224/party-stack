import { Temporal } from "temporal-polyfill";

export const defaultNotebookId = (userId: string) => `${userId}:notes`;

export function deletedFolderNote(notebookId: string, trashed: boolean, now: Temporal.Instant) {
    return {
        notebookId,
        trashed: true,
        favorite: false,
        ...(!trashed ? { updatedAt: now } : {}),
    };
}
