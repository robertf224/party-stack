import { Folder } from "lucide-react";
import { useBootSignal } from "./bootContext";
import { NoteListScroll } from "./NoteListScroll";
import type { NotesListProps } from "./NoteList";

export function MissingFolder(props: NotesListProps) {
    useBootSignal("list");
    return (
        <>
            {props.heading(0, props.view)}
            <NoteListScroll>
                <div className="empty-list">
                    <Folder />
                    <p>This folder isn’t available.</p>
                </div>
            </NoteListScroll>
        </>
    );
}
