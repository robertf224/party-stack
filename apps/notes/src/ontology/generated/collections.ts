// Auto-generated file - do not edit manually

import { ontologyCollections } from "@party-stack/ontology";
import type { NotesOntology } from "./types";

const linkDefinitions = {
    Note: {
        notebook: { objectType: "Notebook", source: ["notebookId"], target: ["id"] },
        attachments: { objectType: "NoteAttachment", source: ["id"], target: ["noteId"] },
    },
    Notebook: { notes: { objectType: "Note", source: ["id"], target: ["notebookId"] } },
    NoteAttachment: { note: { objectType: "Note", source: ["noteId"], target: ["id"] } },
} as const;
export const { objects, cachedObjects } = ontologyCollections<NotesOntology, typeof linkDefinitions>(
    { Preferences: "id", Notebook: "id", Note: "id", NoteAttachment: "id" },
    linkDefinitions
);
