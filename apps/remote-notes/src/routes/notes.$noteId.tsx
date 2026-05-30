import { createFileRoute } from "@tanstack/react-router";
import { NotePage } from "../notes/NotesViews";

export const Route = createFileRoute("/notes/$noteId")({
    component: NoteRoute,
});

function NoteRoute() {
    const { noteId } = Route.useParams();
    return <NotePage noteId={noteId} />;
}
