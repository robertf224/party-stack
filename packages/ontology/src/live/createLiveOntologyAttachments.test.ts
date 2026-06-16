import { createInMemoryBlobStore } from "@party-stack/blobs";
import { describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { createLiveOntology } from "./LiveOntology.js";
import type { OntologyAdapter } from "./index.js";
import type { OntologyIR } from "../ir/index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [
        {
            name: "Document",
            displayName: "Document",
            pluralDisplayName: "Documents",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "file", displayName: "File", type: o.attachment({}) },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
};

describe("createLiveOntologyAttachments", () => {
    it("can eagerly materialize staged attachments when the adapter supports it", async () => {
        const store = createInMemoryBlobStore("test");
        const materialized: string[] = [];
        const adapter: OntologyAdapter = {
            name: "test",
            getCollectionOptions: () => ({
                syncMode: "eager",
                sync: {
                    sync: ({ markReady }) => {
                        markReady();
                    },
                },
            }),
            applyAction: () => Promise.resolve(),
            runQueryFunction: () => Promise.reject(new Error("unexpected query run")),
            attachments: {
                generateAttachmentId: () => "attachment-1",
                materializeAttachment: async (attachment, blob) => {
                    materialized.push(`${attachment.id}:${await blob.text()}`);
                },
                getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
                getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
            },
        };
        const ontology = createLiveOntology({
            ir,
            adapter,
            blobStore: () => store,
        });

        const attachment = await ontology.attachments!.create(new Blob(["hello"]), {
            target: {
                objectType: "Document",
                property: "file",
            },
            eager: true,
        });

        expect(attachment.id).toBe("attachment-1");
        expect(materialized).toEqual(["attachment-1:hello"]);
        await expect(store.get("attachment-1")).resolves.toMatchObject({
            id: "attachment-1",
            state: "persisted",
        });
    });
});
