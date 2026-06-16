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
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        { property: ["id"], value: o.Expression.valueReference({ path: ["id"] }) },
                        { property: ["ownerEmail"], value: o.Expression.valueReference({ path: ["ownerEmail"] }) },
                        { property: ["title"], value: o.Expression.valueReference({ path: ["title"] }) },
                        {
                            property: ["bodyMarkdown"],
                            value: o.Expression.valueReference({ path: ["bodyMarkdown"] }),
                        },
                        {
                            property: ["createdAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
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
                    object: { path: ["note"] },
                    values: [
                        { property: ["title"], value: o.Expression.valueReference({ path: ["title"] }) },
                        {
                            property: ["bodyMarkdown"],
                            value: o.Expression.valueReference({ path: ["bodyMarkdown"] }),
                        },
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
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
            logic: [o.ActionLogicStep.deleteObject({ object: { path: ["note"] } })],
        },
        {
            name: "createNoteAttachment",
            displayName: "Create Note Attachment",
            parameters: [
                {
                    name: "id",
                    displayName: "ID",
                    type: o.string({}),
                    defaultValue: o.Expression.valueReference({ path: ["attachment", "id"] }),
                },
                { name: "note", displayName: "Note", type: o.objectReference({ objectType: "Note" }) },
                {
                    name: "ownerEmail",
                    displayName: "Owner Email",
                    type: o.string({}),
                    defaultValue: o.Expression.contextReference({ path: ["user", "email"] }),
                },
                { name: "attachment", displayName: "Attachment", type: o.attachment({}) },
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "NoteAttachment",
                    values: [
                        { property: ["id"], value: o.Expression.valueReference({ path: ["id"] }) },
                        { property: ["noteId"], value: o.Expression.valueReference({ path: ["note"] }) },
                        { property: ["ownerEmail"], value: o.Expression.valueReference({ path: ["ownerEmail"] }) },
                        {
                            property: ["attachment"],
                            value: o.Expression.valueReference({ path: ["attachment"] }),
                        },
                        {
                            property: ["createdAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
                    ],
                }),
                o.ActionLogicStep.updateObject({
                    object: { path: ["note"] },
                    values: [
                        {
                            property: ["updatedAt"],
                            value: o.Expression.functionCall(o.FunctionCallExpression.now({})),
                        },
                    ],
                }),
            ],
        },
    ],
    queryFunctionTypes: [],
} satisfies OntologyIR;

export default notesOntology;
