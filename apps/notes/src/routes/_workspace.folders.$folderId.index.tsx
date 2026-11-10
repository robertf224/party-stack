import { createFileRoute } from "@tanstack/react-router";
import { EmptyNote } from "../notes/NotesViews";

export const Route = createFileRoute("/_workspace/folders/$folderId/")({ component: EmptyNote });
