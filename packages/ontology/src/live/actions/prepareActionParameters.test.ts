import { createBlobManager } from "@party-stack/blobs";
import { MemoryBlobBytesStore, SingleProcessCoordination } from "@party-stack/runtime";
import { describe, expect, it } from "vitest";
import { o } from "../../ir/index.js";
import { prepareActionParameters } from "./prepareActionParameters.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyBackendAdapter } from "../OntologyBackendAdapter.js";

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

const backendAdapter: OntologyBackendAdapter = {
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
        const coordination = new SingleProcessCoordination({
            scope: "prepare-action-parameters-test",
        });
        const blobManager = createBlobManager({
            runtime: {
                owner: "test",
                namespace: "prepare-action",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
            },
            remote: {
                metadata: (id) => Promise.resolve({ id, size: 0, type: "", name: "" }),
                read: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await blobManager.stage("attachment-1", new Blob(["hello"]));

        const prepared = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters: {
                file: { id: "attachment-1" },
            },
            backendAdapter,
            blobManager,
        });

        expect(prepared.attachmentUploads).toHaveLength(1);
        expect(prepared.attachmentUploads[0]).toMatchObject({
            attachment: { id: "attachment-1" },
        });
        expect(prepared.attachmentUploads[0]!.target).toEqual({});
        await expect(prepared.attachmentUploads[0]!.blob.text()).resolves.toBe("hello");
        await blobManager.cleanup();
        await coordination.close();
    });

    it("replaces materialized attachments and records id mappings", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "materialize-action-parameters-test",
        });
        const blobManager = createBlobManager({
            runtime: {
                owner: "test",
                namespace: "materialize-action",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
            },
            remote: {
                metadata: (id) =>
                    Promise.resolve({
                        id,
                        size: 0,
                        type: "",
                    }),
                read: () => Promise.reject(new Error("unexpected remote read")),
            },
        });
        await blobManager.stage(
            "local-id",
            new Blob(["hello"], {
                type: "image/png",
            })
        );
        const materializingAdapter: OntologyBackendAdapter = {
            ...backendAdapter,
            attachments: {
                ...backendAdapter.attachments!,
                materializeAttachment: async (attachment, blob) => {
                    await expect(blob.text()).resolves.toBe("hello");
                    return {
                        ...attachment,
                        id: "remote-id",
                    };
                },
            },
        };
        const parameters = {
            file: { id: "local-id" },
        };

        const prepared = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters,
            backendAdapter: materializingAdapter,
            blobManager,
        });

        expect(prepared.parameters).toEqual({
            file: { id: "remote-id" },
        });
        expect(parameters).toEqual({
            file: { id: "local-id" },
        });
        expect(prepared.attachmentIdMappings).toEqual([
            {
                localId: "local-id",
                remoteId: "remote-id",
            },
        ]);
        expect(blobManager.collection.get("local-id")?.remoteId).toBeUndefined();

        await blobManager.stage("upload-id", new Blob(["upload"]));
        const uploadAdapter: OntologyBackendAdapter = {
            ...materializingAdapter,
            attachments: {
                ...materializingAdapter.attachments!,
                canMaterializeAttachment: () => false,
            },
        };
        const uploaded = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters: {
                file: { id: "upload-id" },
            },
            backendAdapter: uploadAdapter,
            blobManager,
        });

        expect(uploaded.parameters).toEqual({
            file: { id: "upload-id" },
        });
        expect(uploaded.attachmentIdMappings).toEqual([]);
        expect(uploaded.attachmentUploads).toHaveLength(1);
        await expect(uploaded.attachmentUploads[0]!.blob.text()).resolves.toBe("upload");

        await blobManager.cleanup();
        await coordination.close();
    });
});
