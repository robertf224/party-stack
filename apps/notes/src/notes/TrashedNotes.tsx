import { Query } from "@tanstack/db";
import { objects } from "../ontology/generated/collections";
import { NoteList, noteListFragment, type NotesListProps } from "./NoteList";

export function trashedNotesQuery(search = "") {
    return noteListFragment.query(new Query().from({ row: objects.Note }), {
        search,
        trashed: true,
    });
}
export function TrashedNotes(props: NotesListProps) {
    return <NoteList {...props} notes={trashedNotesQuery(props.search)} />;
}
