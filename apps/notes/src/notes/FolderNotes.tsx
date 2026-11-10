import { defineFragment, useFragment, type FragmentRef } from "@party-stack/ontology-react";
import { objects } from "../ontology/generated/collections";
import { MissingFolder } from "./MissingFolder";
import { NoteList, noteListFragment, type NotesListProps } from "./NoteList";

export const folderNotesFragment = defineFragment(objects.Notebook, (folder, { search = "" }) => ({
    notes: noteListFragment.include(objects.Notebook.links.notes(folder), { search }),
}));

export function FolderNotes({
    folder,
    ...props
}: NotesListProps & { folder: FragmentRef<typeof folderNotesFragment> }) {
    const { data } = useFragment(folder);
    return data ? <NoteList {...props} notes={data.notes} /> : <MissingFolder {...props} />;
}
