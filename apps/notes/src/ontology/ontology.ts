import { o, type OntologyIR, type TypeDef } from "@party-stack/ontology";
import {
    and,
    context,
    eq,
    exists,
    field,
    input,
    literal,
    selectField,
    sub,
} from "@party-stack/ontology/query";

const property = (name: string, type: TypeDef) => ({ name, displayName: name, type });
const text = () => o.string({});
const optional = (type: TypeDef) => o.optional({ type });
const common = [property("id", text()), property("ownerId", text())];
const times = [property("createdAt", o.timestamp({})), property("updatedAt", o.timestamp({}))];
const ref = (objectType: string) => o.objectReference({ objectType });
const value = (name: string) => o.Expression.inputReference({ name });
const assignment = (name: string) => ({ property: [name], value: value(name) });
const owned = (type: string, binding: string, id: ReturnType<typeof input>) => ({
    from: { source: { objectType: type }, binding },
    where: and(eq(field(binding, "id"), id), eq(field(binding, "ownerId"), context("userId"))),
});
const definition = {
    types: [],
    objectTypes: [
        {
            name: "Preferences",
            displayName: "Preferences",
            pluralDisplayName: "Preferences",
            primaryKey: "id",
            icon: { name: "settings" },
            color: "#76b6a3",
            properties: [
                ...common,
                property("foldersWidth", o.integer({})),
                property("notesWidth", o.integer({})),
            ],
        },
        {
            name: "Notebook",
            displayName: "Notebook",
            pluralDisplayName: "Notebooks",
            primaryKey: "id",
            icon: { name: "folder" },
            color: "#7eabdf",
            properties: [...common, property("name", text()), property("color", text())],
        },
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            icon: { name: "document" },
            color: "#e2b84b",
            properties: [
                ...common,
                property("notebookId", ref("Notebook")),
                property("title", text()),
                property("bodyMarkdown", text()),
                property(
                    "kind",
                    o.string({
                        constraint: o.StringConstraint.enum({
                            options: ["note", "secure", "login"].map((value) => ({ value, label: value })),
                        }),
                    })
                ),
                property("favorite", o.boolean({})),
                property("trashed", o.boolean({})),
                property("secret", optional(o.encrypted({ type: text() }))),
                ...times,
            ],
        },
        {
            name: "NoteAttachment",
            displayName: "Attachment",
            pluralDisplayName: "Attachments",
            primaryKey: "id",
            icon: { name: "attachment" },
            color: "#ba93d8",
            properties: [
                ...common,
                property("noteId", ref("Note")),
                property("file", o.attachment({})),
                property("createdAt", o.timestamp({})),
            ],
        },
    ],
    linkTypes: [
        {
            id: "notebookNotes",
            source: { objectType: "Note", name: "notes", displayName: "Notes" },
            target: { objectType: "Notebook", name: "notebook", displayName: "Notebook" },
            foreignKey: "notebookId",
            cardinality: "many",
        },
        {
            id: "noteAttachments",
            source: { objectType: "NoteAttachment", name: "attachments", displayName: "Attachments" },
            target: { objectType: "Note", name: "note", displayName: "Note" },
            foreignKey: "noteId",
            cardinality: "many",
        },
    ],
    actionTypes: [
        {
            name: "setPanelWidths",
            displayName: "Set panel widths",
            parameters: [
                property("preferences", ref("Preferences")),
                property("foldersWidth", o.integer({})),
                property("notesWidth", o.integer({})),
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "preferences" },
                    values: ["foldersWidth", "notesWidth"].map(assignment),
                }),
            ],
        },
        {
            name: "createNotebook",
            displayName: "New folder",
            parameters: [property("id", text()), property("name", text()), property("color", text())],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Notebook",
                    values: [
                        ...["id", "name", "color"].map(assignment),
                        { property: ["ownerId"], value: context("userId") },
                    ],
                }),
            ],
        },
        {
            name: "updateNotebook",
            displayName: "Edit folder",
            parameters: [
                property("notebook", ref("Notebook")),
                property("name", text()),
                property("color", text()),
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "notebook" },
                    values: ["name", "color"].map(assignment),
                }),
            ],
        },
        {
            name: "deleteNotebook",
            displayName: "Delete folder",
            parameters: [property("notebook", ref("Notebook"))],
            logic: [],
        },
        {
            name: "createNote",
            displayName: "New note",
            parameters: [
                property("id", text()),
                property("notebookId", ref("Notebook")),
                property("title", text()),
                property("kind", text()),
                property("secret", optional(o.encrypted({ type: text() }))),
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "Note",
                    values: [
                        ...["id", "notebookId", "title", "kind", "secret"].map(assignment),
                        { property: ["ownerId"], value: context("userId") },
                        { property: ["bodyMarkdown"], value: o.Expression.literal({ value: "" }) },
                        { property: ["favorite"], value: o.Expression.literal({ value: false }) },
                        { property: ["trashed"], value: o.Expression.literal({ value: false }) },
                        ...["createdAt", "updatedAt"].map((name) => ({
                            property: [name],
                            value: o.Expression.now({}),
                        })),
                    ],
                }),
            ],
        },
        {
            name: "updateNote",
            displayName: "Edit note",
            parameters: [
                property("note", ref("Note")),
                ...["title", "bodyMarkdown"].map((name) => property(name, optional(text()))),
                property("notebookId", optional(ref("Notebook"))),
                property("favorite", optional(o.boolean({}))),
                property("trashed", optional(o.boolean({}))),
                property("secret", optional(o.encrypted({ type: text() }))),
            ],
            logic: [
                o.ActionLogicStep.updateObject({
                    object: { name: "note" },
                    values: [
                        ...["title", "bodyMarkdown", "notebookId"].map(assignment),
                        {
                            property: ["favorite"],
                            value: o.Expression.case({
                                branches: [
                                    {
                                        condition: eq(input("trashed"), literal(true)),
                                        result: literal(false),
                                    },
                                ],
                                else: value("favorite"),
                            }),
                        },
                        ...["trashed", "secret"].map(assignment),
                        { property: ["updatedAt"], value: o.Expression.now({}) },
                    ],
                }),
            ],
        },
        {
            name: "addAttachment",
            displayName: "Attach file",
            parameters: [
                property("id", text()),
                property("noteId", ref("Note")),
                property("file", o.attachment({})),
            ],
            logic: [
                o.ActionLogicStep.createObject({
                    objectType: "NoteAttachment",
                    values: [
                        ...["id", "noteId", "file"].map(assignment),
                        { property: ["ownerId"], value: context("userId") },
                        { property: ["createdAt"], value: o.Expression.now({}) },
                    ],
                }),
            ],
        },
        {
            name: "removeAttachment",
            displayName: "Remove attachment",
            parameters: [property("attachment", ref("NoteAttachment"))],
            logic: [o.ActionLogicStep.deleteObject({ object: { name: "attachment" } })],
        },
    ],
    // App-only experiment: encrypt before enqueueing a write. Compare with
    // encrypted outbox storage before promoting this into any shared API.
    queryFunctionTypes: [
        {
            name: "sealSecret",
            displayName: "Encrypt secret",
            parameters: [property("value", text())],
            returnType: o.encrypted({ type: text() }),
        },
    ],
} satisfies OntologyIR;

export const notesOntology: OntologyIR = {
    ...definition,
    context: { type: o.struct({ fields: [property("userId", text())] }), partition: [["userId"]] },
    policy: {
        objects: {
            select: definition.objectTypes.map((type) =>
                sub(type.name, {
                    from: { source: { objectType: type.name }, binding: type.name },
                    where: eq(field(type.name, "ownerId"), context("userId")),
                    select: type.properties.map((p) => selectField(p.name, field(type.name, p.name))),
                })
            ),
        },
        actions: definition.actionTypes.map((action) => ({
            actionType: action.name,
            check:
                action.name === "setPanelWidths"
                    ? exists(owned("Preferences", "preferences", input("preferences")))
                    : action.name === "createNotebook"
                      ? literal(true)
                      : action.name === "updateNotebook" || action.name === "deleteNotebook"
                        ? exists(owned("Notebook", "folder", input("notebook")))
                        : action.name === "createNote"
                          ? exists(owned("Notebook", "folder", input("notebookId")))
                          : action.name === "addAttachment"
                            ? exists(owned("Note", "note", input("noteId")))
                            : action.name === "removeAttachment"
                              ? exists(owned("NoteAttachment", "attachment", input("attachment")))
                              : exists(owned("Note", "note", input("note"))),
        })),
        queryFunctions: [{ queryFunctionType: "sealSecret", check: literal(true) }],
    },
};
export default notesOntology;
