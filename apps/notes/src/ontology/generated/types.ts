// Auto-generated file - do not edit manually

import * as v from "@party-stack/ontology/values";

export type Preferences = {
    id: string;
    ownerId: string;
    foldersWidth: v.integer;
    notesWidth: v.integer;
};

export type Notebook = {
    id: string;
    ownerId: string;
    name: string;
    color: string;
};

export type Note = {
    id: string;
    ownerId: string;
    notebookId: string;
    title: string;
    bodyMarkdown: string;
    kind: "note" | "secure" | "login";
    favorite: boolean;
    trashed: boolean;
    secret?: v.Encrypted<string>;
    createdAt: v.timestamp;
    updatedAt: v.timestamp;
};

export type NoteAttachment = {
    id: string;
    ownerId: string;
    noteId: string;
    file: v.attachment;
    createdAt: v.timestamp;
};

export type NotesOntologyContext = {
    userId: string;
} & Record<string, unknown>;
export type SetPanelWidthsParameters = {
    preferences: string;
    foldersWidth: v.integer;
    notesWidth: v.integer;
};
export type CreateNotebookParameters = {
    id: string;
    name: string;
    color: string;
};
export type UpdateNotebookParameters = {
    notebook: string;
    name: string;
    color: string;
};
export type DeleteNotebookParameters = {
    notebook: string;
};
export type CreateNoteParameters = {
    id: string;
    notebookId: string;
    title: string;
    kind: string;
    secret?: v.Encrypted<string> | null;
};
export type UpdateNoteParameters = {
    note: string;
    title?: string | null;
    bodyMarkdown?: string | null;
    notebookId?: string | null;
    favorite?: boolean | null;
    trashed?: boolean | null;
    secret?: v.Encrypted<string> | null;
};
export type AddAttachmentParameters = {
    id: string;
    noteId: string;
    file: v.attachment;
};
export type AddAttachmentInput = {
    id: string;
    noteId: string;
    file: v.attachment | Blob;
};
export type RemoveAttachmentParameters = {
    attachment: string;
};
export type SealSecretParameters = {
    value: string;
};
export type SealSecretReturn = v.Encrypted<string>;
export type NotesOntology = {
    context: NotesOntologyContext;
    objectTypes: {
        Preferences: Preferences;
        Notebook: Notebook;
        Note: Note;
        NoteAttachment: NoteAttachment;
    };
    actionTypes: {
        setPanelWidths: {
            parameters: SetPanelWidthsParameters;
            returnType: void;
        };
        createNotebook: {
            parameters: CreateNotebookParameters;
            returnType: void;
        };
        updateNotebook: {
            parameters: UpdateNotebookParameters;
            returnType: void;
        };
        deleteNotebook: {
            parameters: DeleteNotebookParameters;
            returnType: void;
        };
        createNote: {
            parameters: CreateNoteParameters;
            returnType: void;
        };
        updateNote: {
            parameters: UpdateNoteParameters;
            returnType: void;
        };
        addAttachment: {
            parameters: AddAttachmentParameters;
            inputParameters: AddAttachmentInput;
            returnType: void;
        };
        removeAttachment: {
            parameters: RemoveAttachmentParameters;
            returnType: void;
        };
    };
    queryFunctionTypes: {
        sealSecret: {
            parameters: SealSecretParameters;
            returnType: SealSecretReturn;
        };
    };
};
