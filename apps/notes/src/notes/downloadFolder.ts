import { definePin, o } from "@party-stack/ontology";
import { and, eq, field, input, literal, selectField, sub } from "@party-stack/ontology/query";
import ir from "../ontology/ontology";

const properties = (type: string, binding: string) =>
    ir.objectTypes
        .find((object) => object.name === type)!
        .properties.map((property) => selectField(property.name, field(binding, property.name)));
export const downloadFolder = definePin<{ folderId: string }>("downloadFolder", {
    attachments: "all",
    query: {
        inputs: [{ name: "folderId", displayName: "Folder", type: o.string({}) }],
        select: [
            sub("folder", {
                from: { source: { objectType: "Notebook" }, binding: "folder" },
                where: eq(field("folder", "id"), input("folderId")),
                select: [
                    ...properties("Notebook", "folder"),
                    sub("notes", {
                        from: { source: { objectType: "Note" }, binding: "note" },
                        where: and(
                            eq(field("note", "notebookId"), field("folder", "id")),
                            eq(field("note", "trashed"), literal(false))
                        ),
                        select: [
                            ...properties("Note", "note"),
                            sub("attachments", {
                                from: { source: { objectType: "NoteAttachment" }, binding: "attachment" },
                                where: eq(field("attachment", "noteId"), field("note", "id")),
                                select: properties("NoteAttachment", "attachment"),
                            }),
                        ],
                    }),
                ],
            }),
        ],
    },
});
