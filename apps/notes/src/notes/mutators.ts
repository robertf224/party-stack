import { eq, and } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { defaultNotebookId, deletedFolderNote } from "../ontology/folders";
import type { OntologyMutatorRegistry } from "@party-stack/ontology";

// The SDK adapts these Promise mutators to the replica's transaction. The
// worker and authoritative backend use the native version of the same action.
export const notesMutators: OntologyMutatorRegistry = {
    async deleteNotebook({ tx, args, context }) {
        const fallback = defaultNotebookId(context.userId as string);
        if (args.notebook === fallback) throw new Error("The Notes folder cannot be deleted.");
        const notes = await tx.query<{ id: string; trashed: boolean }[]>((q, objects) =>
            q
                .from({ note: objects.Note! })
                .where(({ note }) =>
                    and(eq(note.notebookId, args.notebook), eq(note.ownerId, context.userId))
                )
                .select(({ note }) => ({ id: note.id, trashed: note.trashed }))
        );
        const now = Temporal.Now.instant();
        for (const note of notes)
            await tx.mutate.Note!.update(note.id, deletedFolderNote(fallback, note.trashed, now));
        await tx.mutate.Notebook!.delete(args.notebook as string);
    },
};
