import { definePin, o } from "@party-stack/ontology";
import { eq, field, input, literal, related, row, sub } from "@party-stack/ontology/query";

export const downloadFolder = definePin<{ folderId: string }>("downloadFolder", {
    attachments: "all",
    query: {
        inputs: [{ name: "folderId", displayName: "Folder", type: o.string({}) }],
        select: [
            sub("folder", {
                from: { source: { objectType: "Notebook" }, binding: "folder" },
                where: eq(field("folder", "id"), input("folderId")),
                select: [
                    sub("notes", {
                        from: { source: related(row("folder"), "notes"), binding: "note" },
                        where: eq(field("note", "trashed"), literal(false)),
                        select: [
                            sub("attachments", {
                                from: { source: related(row("note"), "attachments"), binding: "attachment" },
                                select: [],
                            }),
                        ],
                    }),
                ],
            }),
        ],
    },
});
