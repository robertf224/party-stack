import { useOntology } from "@party-stack/ontology-react";
import { eq, Query } from "@tanstack/db";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { defaultNotebookId } from "../ontology/folders";
import { objects } from "../ontology/generated/collections";
import { FolderNotes, folderNotesFragment } from "./FolderNotes";
import { MissingFolder } from "./MissingFolder";
import type { NotesOntology } from "../ontology/generated/types";
import type { NotesListProps } from "./NoteList";

export function folderNotesQuery(id: string, search = "") {
    return new Query()
        .from({ folder: objects.Notebook })
        .where(({ folder }) => eq(folder.id, id))
        .select(({ folder }) => ({
            view: folderNotesFragment.include(folder, {
                search,
            }),
        }))
        .findOne();
}
export function FolderNotesQuery(props: NotesListProps) {
    const ontology = useOntology<NotesOntology>();
    const id = props.view.startsWith("folder:")
        ? props.view.slice(7)
        : defaultNotebookId(ontology.context.userId);
    const { data } = useLiveSuspenseQuery(() => folderNotesQuery(id, props.search));
    return data ? <FolderNotes {...props} folder={data.view} /> : <MissingFolder {...props} />;
}
