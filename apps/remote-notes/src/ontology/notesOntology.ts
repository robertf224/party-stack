import { o } from "@party-stack/ontology";
import type { OntologyIR } from "@party-stack/ontology";

export const notesOntology = {
    types: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "ownerEmail", displayName: "Owner Email", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "bodyMarkdown", displayName: "Body", type: o.string({}) },
                { name: "createdAt", displayName: "Created At", type: o.string({}) },
                { name: "updatedAt", displayName: "Updated At", type: o.string({}) },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create Note",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                    defaultValue: o.Expression.functionCall(o.FunctionCallExpression.uuid({})),
                },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "bodyMarkdown", displayName: "Body", type: o.string({}) },
                {
                    name: "ownerEmail",
                    displayName: "Owner Email",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({ path: ["user", "email"] }),
                },
                {
                    name: "createdAt",
                    displayName: "Created At",
                    type: o.string({}),
                    defaultValue: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                },
                {
                    name: "updatedAt",
                    displayName: "Updated At",
                    type: o.string({}),
                    defaultValue: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                },
            ],
            logic: [],
        },
        {
            name: "updateNote",
            displayName: "Update Note",
            parameters: [
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
                { name: "title", displayName: "Title", type: o.optional({ type: o.string({}) }) },
                { name: "bodyMarkdown", displayName: "Body", type: o.optional({ type: o.string({}) }) },
                {
                    name: "updatedAt",
                    displayName: "Updated At",
                    type: o.string({}),
                    defaultValue: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                },
            ],
            logic: [],
        },
        {
            name: "deleteNote",
            displayName: "Delete Note",
            parameters: [
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
            ],
            logic: [],
        },
    ],
} satisfies OntologyIR;

export type Note = {
    id: string;
    ownerEmail: string;
    title: string;
    bodyMarkdown: string;
    createdAt: string;
    updatedAt: string;
};

export type NotesOntologyDefinition = {
    objectTypes: {
        Note: Note;
    };
    actionTypes: {
        createNote: {
            parameters: {
                id: string;
                title: string;
                bodyMarkdown: string;
                ownerEmail?: string;
                createdAt?: string;
                updatedAt?: string;
            };
        };
        updateNote: {
            parameters: {
                note: string;
                title?: string;
                bodyMarkdown?: string;
                updatedAt?: string;
            };
        };
        deleteNote: {
            parameters: {
                note: string;
            };
        };
    };
};
