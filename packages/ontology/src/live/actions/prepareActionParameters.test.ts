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
        {
            name: "uploadDocumentGroups",
            displayName: "Upload Document Groups",
            parameters: [
                {
                    name: "groups",
                    displayName: "Groups",
                    type: o.list({
                        elementType: o.struct({
                            fields: [
                                {
                                    name: "label",
                                    displayName: "Label",
                                    type: o.string({}),
                                },
                                {
                                    name: "files",
                                    displayName: "Files",
                                    type: o.list({
                                        elementType: o.attachment({}),
                                    }),
                                },
                            ],
                        }),
                    }),
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
                materializeAttachment: async (attachment, blob, materializeOptions) => {
                    await expect(blob.text()).resolves.toBe("hello");
                    expect(materializeOptions.idKind).toBe("local");
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

        await blobManager.stage("preserved-id", new Blob(["preserved"]));
        const preserved = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters: {
                file: { id: "preserved-id" },
            },
            backendAdapter: {
                ...materializingAdapter,
                attachments: {
                    ...materializingAdapter.attachments!,
                    materializeAttachment: (attachment) => Promise.resolve(attachment),
                },
            },
            blobManager,
        });
        expect(preserved.parameters).toEqual({
            file: { id: "preserved-id" },
        });
        expect(preserved.attachmentIdMappings).toEqual([]);
        expect(preserved.attachmentUploads).toEqual([]);

        await blobManager.cleanup();
        await coordination.close();
    });

    it("substitutes known remote IDs and passes existing remote attachments through", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "mapped-action-parameters-test",
        });
        const blobManager = createBlobManager({
            runtime: {
                owner: "test",
                namespace: "mapped-action",
                blobBytes: new MemoryBlobBytesStore(),
                coordination,
            },
            remote: {
                metadata: () => Promise.reject(new Error("unexpected remote metadata read")),
                read: () => Promise.reject(new Error("unexpected remote content read")),
            },
        });
        await blobManager.stage("local-id", new Blob(["hello"]));
        await blobManager.bindRemoteId("local-id", "remote-id");
        let materializationCalls = 0;
        const materializingAdapter: OntologyBackendAdapter = {
            ...backendAdapter,
            attachments: {
                ...backendAdapter.attachments!,
                materializeAttachment: () => {
                    materializationCalls += 1;
                    return Promise.reject(new Error("unexpected materialization"));
                },
            },
        };

        const mapped = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters: {
                file: { id: "local-id", type: "text/plain" },
            },
            backendAdapter: materializingAdapter,
            blobManager,
        });
        expect(mapped).toEqual({
            parameters: {
                file: { id: "remote-id", type: "text/plain" },
            },
            attachmentIdMappings: [],
            attachmentUploads: [],
        });

        const existing = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocument",
            parameters: {
                file: { id: "existing-remote-id", type: "text/plain" },
            },
            backendAdapter: materializingAdapter,
            blobManager,
        });
        expect(existing).toEqual({
            parameters: {
                file: { id: "existing-remote-id", type: "text/plain" },
            },
            attachmentIdMappings: [],
            attachmentUploads: [],
        });
        expect(materializationCalls).toBe(0);

        await blobManager.cleanup();
        await coordination.close();
    });

    it("propagates materialized attachment IDs and mappings through nested lists", async () => {
        const coordination = new SingleProcessCoordination({
            scope: "materialize-nested-action-parameters-test",
        });
        const blobManager = createBlobManager({
            runtime: {
                owner: "test",
                namespace: "materialize-nested-action",
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
        await Promise.all([
            blobManager.stage("local-1", new Blob(["one"])),
            blobManager.stage("local-2", new Blob(["two"])),
        ]);
        const materializingAdapter: OntologyBackendAdapter = {
            ...backendAdapter,
            attachments: {
                ...backendAdapter.attachments!,
                materializeAttachment: (attachment) =>
                    Promise.resolve({
                        ...attachment,
                        id: `remote-${attachment.id}`,
                    }),
            },
        };

        const prepared = await prepareActionParameters({
            ir,
            actionTypeName: "uploadDocumentGroups",
            parameters: {
                groups: [
                    {
                        label: "Group 1",
                        files: [{ id: "local-1" }, { id: "local-2" }],
                    },
                ],
            },
            backendAdapter: materializingAdapter,
            blobManager,
        });

        expect(prepared.parameters).toEqual({
            groups: [
                {
                    label: "Group 1",
                    files: [{ id: "remote-local-1" }, { id: "remote-local-2" }],
                },
            ],
        });
        expect(prepared.attachmentIdMappings).toEqual(
            expect.arrayContaining([
                {
                    localId: "local-1",
                    remoteId: "remote-local-1",
                },
                {
                    localId: "local-2",
                    remoteId: "remote-local-2",
                },
            ])
        );
        expect(prepared.attachmentIdMappings).toHaveLength(2);

        await blobManager.cleanup();
        await coordination.close();
    });
});
