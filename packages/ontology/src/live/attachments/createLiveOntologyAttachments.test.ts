import { o } from "@party-stack/ontology-spec";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { MemoryBlobBytesStore } from "@party-stack/runtime";
import { asRuntimeLayer } from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { createLiveOntology } from "../LiveOntology.js";
import { createLiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
import type { BlobManager } from "../../runtime/blobs/types.js";
import type { OntologyBackendAdapter } from "../index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

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
    it("creates attachments with an existing opaque id", async () => {
        const stage = vi.fn(() => Promise.resolve());
        const attachments = createLiveOntologyAttachments({
            ir,
            blobManager: { stage } as unknown as BlobManager,
        });
        const file = new File(["hello"], "evidence.txt", {
            type: "text/plain",
        });

        await expect(
            attachments.create(file, {
                id: "opaque-local-id",
            })
        ).resolves.toEqual({
            attachment: {
                id: "opaque-local-id",
                type: "text/plain",
            },
        });

        expect(stage).toHaveBeenCalledWith(
            "opaque-local-id",
            expect.objectContaining({ size: 5, type: "text/plain", name: "evidence.txt" })
        );
    });

    it("rejects blobs outside a target's allowed media types", async () => {
        const constrainedIr: OntologyIR = {
            ...ir,
            objectTypes: [
                {
                    ...ir.objectTypes[0]!,
                    properties: [
                        ir.objectTypes[0]!.properties[0]!,
                        {
                            name: "file",
                            displayName: "File",
                            type: o.attachment({
                                constraint: {
                                    content: o.AttachmentContentConstraint.image({
                                        mediaTypes: ["image/png", "image/jpeg"],
                                    }),
                                },
                            }),
                        },
                    ],
                },
            ],
        };
        const stage = vi.fn();
        const attachments = createLiveOntologyAttachments({
            ir: constrainedIr,
            blobManager: { stage } as unknown as BlobManager,
        });

        await expect(
            attachments.create(new Blob(["pdf"], { type: "application/pdf" }), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "file",
                },
            })
        ).rejects.toThrow('Attachment media type "application/pdf" is not allowed by the target.');
        expect(stage).not.toHaveBeenCalled();
    });

    it("enforces cheap attachment constraints before staging", async () => {
        const constrainedIr: OntologyIR = {
            ...ir,
            objectTypes: [
                {
                    ...ir.objectTypes[0]!,
                    properties: [
                        ir.objectTypes[0]!.properties[0]!,
                        {
                            name: "file",
                            displayName: "File",
                            type: o.attachment({
                                constraint: {
                                    size: { max: 10 },
                                    content: o.AttachmentContentConstraint.image({
                                        dimensions: {
                                            width: { max: 100 },
                                        },
                                    }),
                                },
                            }),
                        },
                    ],
                },
            ],
        };
        const stage = vi.fn(() => Promise.resolve());
        const attachments = createLiveOntologyAttachments({
            ir: constrainedIr,
            blobManager: { stage } as unknown as BlobManager,
        });

        await expect(
            attachments.create(new Blob(["avif"], { type: "image/avif" }), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "file",
                },
            })
        ).rejects.toThrow('Attachment media type "image/avif" is not allowed by the target.');
        await expect(
            attachments.create(new Blob(["12345678901"], { type: "image/png" }), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "file",
                },
            })
        ).rejects.toThrow("Attachment size 11 is outside the allowed range.");
        await expect(
            attachments.create(new Blob(["image"], { type: "image/png" }), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "file",
                },
            })
        ).resolves.toMatchObject({
            attachment: { id: expect.any(String) },
        });
        expect(stage).toHaveBeenCalledOnce();
    });

    it("starts eager materialization in the background when the adapter supports it", async () => {
        const runtime = {
            owner: "test-user",
            namespace: "eager-attachment",
            blobBytes: new MemoryBlobBytesStore(),
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
            open: () =>
                Effect.succeed({
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: () => Effect.die("Unexpected action"),
                    queryFunction: () => Effect.die("Unexpected query"),
                    attachments: {
                        stage: (attachment, blob) =>
                            Effect.promise(async () => {
                                resolveMaterializationStarted?.();
                                await materializationStarted;
                                materialized.push(
                                    `${attachment.id}:${await (await Effect.runPromise(collectByteBlob(blob))).text()}`
                                );
                                return attachment;
                            }),
                        read: () => Effect.die("unexpected content read"),
                        metadata: () => Effect.die("unexpected metadata read"),
                    },
                }),
        };
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            runtime: asRuntimeLayer(() => runtime),
        });

        const creation = await ontology.attachments.create(new Blob(["hello"]), {
            id: "attachment-1",
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
        await expect(
            ontology.attachments.blob(creation.attachment).then((blob) => blob.text())
        ).resolves.toBe("hello");
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
        };
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            open: () =>
                Effect.succeed({
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: () => Effect.die("Unexpected action"),
                    queryFunction: () => Effect.die("Unexpected query"),
                }),
        };
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            runtime: asRuntimeLayer(() => runtime),
        });

        const creation = await ontology.attachments.create(new Blob(["hello"]));

        expect(creation.attachment.id).toHaveLength(36);
        expect(creation.isMaterialized).toBeUndefined();
        await expect(
            ontology.attachments.blob(creation.attachment).then((blob) => blob.text())
        ).resolves.toBe("hello");
    });

    it("silently skips eager materialization when unsupported", async () => {
        const runtime = {
            owner: "test-user",
            namespace: "unsupported-attachment",
            blobBytes: new MemoryBlobBytesStore(),
        };
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            open: () =>
                Effect.succeed({
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: () => Effect.die("Unexpected action"),
                    queryFunction: () => Effect.die("Unexpected query"),
                }),
        };
        const ontology = await createLiveOntology({
            ir,
            backend: () => backendAdapter,
            runtime: asRuntimeLayer(() => runtime),
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
            ontology.attachments.blob(creation.attachment).then((blob) => blob.text())
        ).resolves.toBe("hello");
    });

    it("applies attachment id mappings returned by actions", async () => {
        const runtime = {
            owner: "test-user",
            namespace: "attachment-mapping",
            blobBytes: new MemoryBlobBytesStore(),
        };
        const backendAdapter: OntologyBackendAdapter = {
            name: "test",
            open: () =>
                Effect.succeed({
                    name: "test",
                    sourceId: "test",
                    supportsIdempotency: false,
                    loadSubset: () => Effect.succeed({ rows: [], complete: true }),
                    applyAction: (action) =>
                        Effect.succeed({
                            operationId: action.id,
                            outcome: "committed",
                            affected: [],
                            attachmentIdMappings: [{ localId: "local-id", remoteId: "remote-id" }],
                        }),
                    queryFunction: () => Effect.die("Unexpected query"),
                }),
        };
        const ontology = await createLiveOntology({
            ir: actionIr,
            backend: () => backendAdapter,
            runtime: asRuntimeLayer(() => runtime),
        });
        const { attachment } = await ontology.attachments.create(new Blob(["hello"]), {
            id: "local-id",
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
