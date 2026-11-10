import { createFileRoute } from "@tanstack/react-router";
import { handleNotes } from "../server/ontology";
export const Route = createFileRoute("/api/ontology/$endpoint")({
    server: {
        handlers: { POST: ({ request }) => handleNotes(request), GET: ({ request }) => handleNotes(request) },
    },
});
