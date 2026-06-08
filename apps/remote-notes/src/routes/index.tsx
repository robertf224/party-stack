import { createFileRoute } from "@tanstack/react-router";
import { NotesHomePage } from "../notes/NotesViews";

export const Route = createFileRoute("/")({
    component: NotesHomePage,
});
