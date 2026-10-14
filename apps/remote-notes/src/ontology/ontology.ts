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
                { name: "createdAt", displayName: "Created At", type: o.timestamp({}) },
                { name: "updatedAt", displayName: "Updated At", type: o.timestamp({}) },
            ],
        },
        {
            name: "NoteAttachment",
            displayName: "Note Attachment",
            pluralDisplayName: "Note Attachments",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "noteId", displayName: "Note ID", type: o.string({}) },
                { name: "ownerEmail", displayName: "Owner Email", type: o.string({}) },
                { name: "attachment", displayName: "Attachment", type: o.attachment({}) },
                { name: "createdAt", displayName: "Created At", type: o.timestamp({}) },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "createNote",
            displayName: "Create Note",
            parameters: [
                { name: "id", displayName: "ID", type: o.string({}), defaultValue: o.Expression.uuid({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "bodyMarkdown", displayName: "Body", type: o.string({}) },
                {
                    name: "ownerEmail",
                    displayName: "Owner Email",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({ name: "user" }),
                },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        { property: ["id"], value: o.Expression.inputReference({ name: "id" }) },
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.inputReference({ name: "ownerEmail" }),
                        },
                        { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
                        {
                            property: ["bodyMarkdown"],
                            value: o.Expression.inputReference({ name: "bodyMarkdown" }),
                        },
                        { property: ["createdAt"], value: o.Expression.now({}) },
                        { property: ["updatedAt"], value: o.Expression.now({}) },
                    ],
                }),
            ],
        },
        {
            name: "updateNote",
            displayName: "Update Note",
            parameters: [
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
                { name: "title", displayName: "Title", type: o.optional({ type: o.string({}) }) },
                { name: "bodyMarkdown", displayName: "Body", type: o.optional({ type: o.string({}) }) },
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "note" },
                    values: [
                        { property: ["title"], value: o.Expression.inputReference({ name: "title" }) },
                        {
                            property: ["bodyMarkdown"],
                            value: o.Expression.inputReference({ name: "bodyMarkdown" }),
                        },
                        { property: ["updatedAt"], value: o.Expression.now({}) },
                    ],
                }),
            ],
        },
        {
            name: "deleteNote",
            displayName: "Delete Note",
            parameters: [
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
            ],
            logic: [o.ActionLogicStep.deleteObject({ object: { name: "note" } })],
        },
        {
            name: "createNoteAttachment",
            displayName: "Create Note Attachment",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                    defaultValue: o.Expression.getAt({
                        source: o.Expression.inputReference({ name: "attachment" }),
                        path: ["id"],
                    }),
                },
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
                {
                    name: "ownerEmail",
                    displayName: "Owner Email",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({ name: "user" }),
                },
                { name: "attachment", displayName: "Attachment", type: o.attachment({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "NoteAttachment",
                    values: [
                        { property: ["id"], value: o.Expression.inputReference({ name: "id" }) },
                        { property: ["noteId"], value: o.Expression.inputReference({ name: "note" }) },
                        {
                            property: ["ownerEmail"],
                            value: o.Expression.inputReference({ name: "ownerEmail" }),
                        },
                        {
                            property: ["attachment"],
                            value: o.Expression.inputReference({ name: "attachment" }),
                        },
                        { property: ["createdAt"], value: o.Expression.now({}) },
                    ],
                }),
                o.ActionLogicStep.updateObject({
                    object: { name: "note" },
                    values: [{ property: ["updatedAt"], value: o.Expression.now({}) }],
                }),
            ],
        },
    ],
    queryFunctionTypes: [],
} satisfies OntologyIR;

export default notesOntology;
