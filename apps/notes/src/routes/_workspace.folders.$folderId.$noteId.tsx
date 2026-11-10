import { createFileRoute } from "@tanstack/react-router";
import { NotePage } from "../notes/NoteEditor";

export const Route = createFileRoute("/_workspace/folders/$folderId/$noteId")({
    component: NoteRoute,
});
function NoteRoute() {
    const { noteId } = Route.useParams();
    return <NotePage noteId={noteId} />;
}
