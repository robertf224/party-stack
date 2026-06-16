import { createBlobManager, createInMemoryBlobStore } from "@party-stack/blobs";
import { describe, expect, it } from "vitest";
import { o } from "../ir/index.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";

const ir: OntologyIR = {
    types: [],
    objectTypes: [],
    linkTypes: [],
    actionTypes: [
        {
            name: "uploadDocument",
            displayName: "Upload Document",
            parameters: [
                {
                    name: "file",
                    displayName: "File",
                    type: o.attachment({}),
                },
            ],
            logic: [],
        },
    ],
    queryFunctionTypes: [],
};

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
        getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
        getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
    },
};

describe("prepareActionParameters", () => {
    it("collects action attachment uploads with resolved attachment type targets", async () => {
        const store = createInMemoryBlobStore("test");
        const blobManager = createBlobManager({
            store,
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                blob: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await blobManager.stage("attachment-1", new Blob(["hello"]));

        const prepared = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters: {
                file: { id: "attachment-1" },
            },
            adapter,
            blobManager,
        });

        expect(prepared.attachmentUploads).toHaveLength(1);
        expect(prepared.attachmentUploads[0]).toMatchObject({
            attachment: { id: "attachment-1" },
        });
        expect(prepared.attachmentUploads[0]!.target).toEqual({});
        await expect(prepared.attachmentUploads[0]!.blob.text()).resolves.toBe("hello");
    });
});
