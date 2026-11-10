import { FolderNotesQuery } from "./FolderNotesQuery";
import { TrashedNotes } from "./TrashedNotes";
import type { NotesListProps } from "./NoteList";

export function NotesListQuery(props: NotesListProps) {
    return props.view === "trash" ? <TrashedNotes {...props} /> : <FolderNotesQuery {...props} />;
}
