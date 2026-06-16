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

const actionIr: OntologyIR = {
    ...ir,
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
};

describe("createLiveOntologyAttachments", () => {
    it("starts eager materialization in the background when the adapter supports it", async () => {
        const store = createInMemoryBlobStore("test");
        const materialized: string[] = [];
        let finishMaterialization: (() => void) | undefined;
        const materializationStarted = new Promise<void>((resolve) => {
            finishMaterialization = resolve;
        });
        let resolveMaterializationStarted: (() => void) | undefined;
        const materializationStartedSignal = new Promise<void>((resolve) => {
            resolveMaterializationStarted = resolve;
        });
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
                    resolveMaterializationStarted?.();
                    await materializationStarted;
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

        const creation = await ontology.attachments.create(new Blob(["hello"]), {
            target: {
                kind: "objectProperty",
                objectType: "Document",
                property: "file",
            },
            eager: true,
        });

        expect(creation.attachment.id).toBe("attachment-1");
        expect(creation.isMaterialized).toBeDefined();
        await materializationStartedSignal;
        await expect(store.get("attachment-1")).resolves.toMatchObject({
            id: "attachment-1",
            state: "uploading",
        });
        expect(materialized).toEqual([]);
        finishMaterialization?.();
        await creation.isMaterialized;
        expect(materialized).toEqual(["attachment-1:hello"]);
        await expect(store.get("attachment-1")).resolves.toMatchObject({
            id: "attachment-1",
            state: "persisted",
        });
    });

    it("can stage targetless attachments with local ids", async () => {
        const store = createInMemoryBlobStore("test");
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
                generateAttachmentId: () => "local-id",
                getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
                getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
            },
        };
        const ontology = createLiveOntology({
            ir,
            adapter,
            blobStore: () => store,
        });

        const creation = await ontology.attachments.create(new Blob(["hello"]));

        expect(creation.attachment.id).toHaveLength(36);
        expect(creation.isMaterialized).toBeUndefined();
        await expect(store.get(creation.attachment.id)).resolves.toMatchObject({
            id: creation.attachment.id,
            state: "staged",
        });
    });

    it("silently skips eager materialization when unsupported", async () => {
        const store = createInMemoryBlobStore("test");
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
                getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
                getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
            },
        };
        const ontology = createLiveOntology({
            ir,
            adapter,
            blobStore: () => store,
        });

        const creation = await ontology.attachments.create(new Blob(["hello"]), {
            target: {
                kind: "objectProperty",
                objectType: "Document",
                property: "file",
            },
            eager: true,
        });

        expect(creation.isMaterialized).toBeUndefined();
        await expect(store.get(creation.attachment.id)).resolves.toMatchObject({
            id: "attachment-1",
            state: "staged",
        });
    });

    it("applies attachment id mappings returned by actions", async () => {
        const store = createInMemoryBlobStore("test");
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
            applyAction: () =>
                Promise.resolve({
                    attachmentIdMappings: [
                        {
                            localId: "local-id",
                            remoteId: "remote-id",
                        },
                    ],
                }),
            runQueryFunction: () => Promise.reject(new Error("unexpected query run")),
            attachments: {
                generateAttachmentId: () => "local-id",
                getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
                getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
            },
        };
        const ontology = createLiveOntology({
            ir: actionIr,
            adapter,
            blobStore: () => store,
        });
        const { attachment } = await ontology.attachments.create(new Blob(["hello"]), {
            target: {
                kind: "objectProperty",
                objectType: "Document",
                property: "file",
            },
        });

        const uploadDocument = ontology.actions.uploadDocument;
        expect(uploadDocument).toBeDefined();

        await uploadDocument!({
            file: attachment,
        }).mutationFn();

        await expect(store.get("remote-id")).resolves.toMatchObject({
            id: "local-id",
            remoteId: "remote-id",
            state: "persisted",
        });
    });
});
