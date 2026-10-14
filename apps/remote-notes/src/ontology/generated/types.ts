// Auto-generated file - do not edit manually

import * as v from "@party-stack/ontology/values";

export type Note = {
    id: string;
    ownerEmail: string;
    title: string;
    bodyMarkdown: string;
    createdAt: v.timestamp;
    updatedAt: v.timestamp;
};

export type NoteAttachment = {
    id: string;
    noteId: string;
    ownerEmail: string;
    attachment: v.attachment;
    createdAt: v.timestamp;
};

export type CreateNoteParameters = {
    id?: string;
    title: string;
    bodyMarkdown: string;
    ownerEmail?: string;
};
export type UpdateNoteParameters = {
    note: string;
    title?: string | null;
    bodyMarkdown?: string | null;
};
export type DeleteNoteParameters = {
    note: string;
};
export type CreateNoteAttachmentParameters = {
    id?: string;
    note: string;
    ownerEmail?: string;
    attachment: v.attachment;
};
export type RemoteNotesOntology = {
    objectTypes: {
        Note: Note;
        NoteAttachment: NoteAttachment;
    };
    actionTypes: {
        createNote: {
            parameters: CreateNoteParameters;
        };
        updateNote: {
            parameters: UpdateNoteParameters;
        };
        deleteNote: {
            parameters: DeleteNoteParameters;
        };
        createNoteAttachment: {
            parameters: CreateNoteAttachmentParameters;
        };
    };
    queryFunctionTypes: Record<never, never>;
};
