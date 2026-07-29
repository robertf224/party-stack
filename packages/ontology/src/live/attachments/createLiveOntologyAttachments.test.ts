import { MemoryBlobBytesStore, SingleProcessCoordination } from "@party-stack/runtime";
import { describe, expect, it } from "vitest";
import { o } from "../../ir/index.js";
import { createLiveOntology } from "../LiveOntology.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyBackendAdapter } from "../index.js";

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
        const runtime = {
            owner: "test-user",
            namespace: "eager-attachment",
            blobBytes: new MemoryBlobBytesStore(),
            coordination: new SingleProcessCoordination({
                scope: "eager-attachment",
            }),
        };
        const materialized: string[] = [];
        let finishMaterialization: (() => void) | undefined;
        const materializationStarted = new Promise<void>((resolve) => {
            finishMaterialization = resolve;
        });
        let resolveMaterializationStarted: (() => void) | undefined;
        const materializationStartedSignal = new Promise<void>((resolve) => {
            resolveMaterializationStarted = resolve;
        });
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
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            runtime: () => runtime,
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
        await expect(runtime.blobBytes.read("attachment-1").then((blob) => blob.text())).resolves.toBe(
            "hello"
        );
        expect(materialized).toEqual([]);
        finishMaterialization?.();
        await creation.isMaterialized;
        expect(materialized).toEqual(["attachment-1:hello"]);
        await expect(
            ontology.attachments.blob(creation.attachment).then((blob) => blob.text())
        ).resolves.toBe("hello");
    });

    it("can stage targetless attachments with local ids", async () => {
        const runtime = {
            owner: "test-user",
            namespace: "targetless-attachment",
            blobBytes: new MemoryBlobBytesStore(),
            coordination: new SingleProcessCoordination({
                scope: "targetless-attachment",
            }),
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
                generateAttachmentId: () => "local-id",
                getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
                getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
            },
        };
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            runtime: () => runtime,
        });

        const creation = await ontology.attachments.create(new Blob(["hello"]));

        expect(creation.attachment.id).toHaveLength(36);
        expect(creation.isMaterialized).toBeUndefined();
        await expect(
            runtime.blobBytes.read(creation.attachment.id).then((blob) => blob.text())
        ).resolves.toBe("hello");
    });

    it("silently skips eager materialization when unsupported", async () => {
        const runtime = {
            owner: "test-user",
            namespace: "unsupported-attachment",
            blobBytes: new MemoryBlobBytesStore(),
            coordination: new SingleProcessCoordination({
                scope: "unsupported-attachment",
            }),
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
                generateAttachmentId: () => "attachment-1",
                getAttachmentContent: () => Promise.reject(new Error("unexpected content read")),
                getAttachmentMetadata: () => Promise.reject(new Error("unexpected metadata read")),
            },
        };
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            runtime: () => runtime,
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
        await expect(
            runtime.blobBytes.read(creation.attachment.id).then((blob) => blob.text())
        ).resolves.toBe("hello");
    });

    it("applies attachment id mappings returned by actions", async () => {
        const runtime = {
            owner: "test-user",
            namespace: "attachment-mapping",
            blobBytes: new MemoryBlobBytesStore(),
            coordination: new SingleProcessCoordination({
                scope: "attachment-mapping",
            }),
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
        const ontology = await createLiveOntology({
            ir: actionIr,
            backend: () => backendAdapter,
            runtime: () => runtime,
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
        });

        await expect(
            ontology.attachments
                .blob({
                    ...attachment,
                    id: "remote-id",
                })
                .then((blob) => blob.text())
        ).resolves.toBe("hello");
    });
});
