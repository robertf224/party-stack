import { executeQuery } from "@party-stack/ontology-backend/query";
import { evaluateQuery } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import ir from "../ontology/ontology";
import { downloadFolder } from "./downloadFolder";

test("a folder download retains its notes and attachment handles, excluding trash and other folders", async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
        Preferences: [{ id: "device:preferences", userId: "device" }],
        Notebook: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
        ],
        Note: [
            { id: "a-note", notebookId: "a", trashed: false, title: "A" },
            { id: "b-note", notebookId: "b", trashed: false, title: "B" },
            { id: "deleted", notebookId: "a", trashed: true, title: "Deleted" },
        ],
        NoteAttachment: [
            { id: "a-file", noteId: "a-note", file: { id: "a-bytes" } },
            { id: "b-file", noteId: "b-note", file: { id: "b-bytes" } },
            { id: "deleted-file", noteId: "deleted", file: { id: "deleted-bytes" } },
        ],
    };
    const result = await Effect.runPromise(
        executeQuery(downloadFolder.query, {
            inputs: { folderId: "a" },
            reader: {
                ir,
                loadSubset: (objectType, subset) =>
                    Effect.sync(() =>
                        evaluateQuery(
                            (rows[objectType] ?? []).map((value) => ({ key: value.id as string, value })),
                            subset
                        )
                    ),
            },
            mode: "entity",
        })
    );
    expect(
        [...new Set(result.entities.map((entity) => `${entity.objectType}:${entity.key}`))].sort()
    ).toEqual(["Note:a-note", "NoteAttachment:a-file", "Notebook:a"]);
    expect(
        result.entities.find((entity) => entity.objectType === "NoteAttachment")?.properties.has("file")
    ).toBe(true);
});
