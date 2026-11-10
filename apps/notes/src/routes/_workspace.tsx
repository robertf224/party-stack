import { createFileRoute } from "@tanstack/react-router";
import { NotesProvider } from "../notes/NotesProvider";
import { NotesLayout } from "../notes/NotesViews";

export const Route = createFileRoute("/_workspace")({ ssr: false, component: WorkspaceRoute });
function WorkspaceRoute() {
    return (
        <NotesProvider>
            <NotesLayout />
        </NotesProvider>
    );
}
