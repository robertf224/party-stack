import { o } from "@party-stack/ontology";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import {
    createFoundryOntologyBackendAdapter,
    isFoundryNotFoundError,
} from "./createFoundryOntologyBackendAdapter.js";
import { encodeFoundryMediaId } from "./foundryMediaId.js";

const mediaMocks = vi.hoisted(() => ({
    metadata: vi.fn(),
    uploadMedia: vi.fn(),
}));
const ontologyMocks = vi.hoisted(() => ({
    applyWithOverrides: vi.fn(),
    getMediaContent: vi.fn(),
    getMediaMetadata: vi.fn(),
}));

vi.mock("@osdk/foundry.mediasets", () => ({
    MediaSets: mediaMocks,
}));
vi.mock("@osdk/foundry.ontologies", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.ontologies")>();
    return {
        ...original,
        Actions: {
            ...original.Actions,
            applyWithOverrides: ontologyMocks.applyWithOverrides,
        },
        MediaReferenceProperties: {
            ...original.MediaReferenceProperties,
            getMediaContent: ontologyMocks.getMediaContent,
            getMediaMetadata: ontologyMocks.getMediaMetadata,
        },
    };
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe("isFoundryNotFoundError", () => {
    it("recognizes Foundry HTTP and API not-found errors", () => {
        expect(
            isFoundryNotFoundError({
                statusCode: 404,
            })
        ).toBe(true);
        expect(
            isFoundryNotFoundError({
                errorCode: "NOT_FOUND",
            })
        ).toBe(true);
        expect(
            isFoundryNotFoundError({
                statusCode: 500,
            })
        ).toBe(false);
    });
});

describe("Foundry media attachments", () => {
    const mediaId = {
        mediaSetRid: "ri.mio.main.media-set.1",
        mediaSetViewRid: "ri.mio.main.view.2",
        mediaItemRid: "ri.mio.main.media-item.3",
    };
    const mediaReference = {
        mimeType: "image/png",
        reference: {
            type: "mediaSetViewItem" as const,
            mediaSetViewItem: mediaId,
        },
    };
    const mediaType = o.attachment({
        meta: { type: "media" },
    });
    const adapter = createFoundryOntologyBackendAdapter({
        client: {
            ontologyRid: "ri.ontology.main.1",
        } as OntologyClient,
        ir: {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [
                {
                    name: "createMedia",
                    displayName: "Create Media",
                    parameters: [
                        {
                            name: "media",
                            displayName: "Media",
                            type: mediaType,
                        },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        },
    });
    const attachments = adapter.attachments!;
    const getAttachmentMetadata = attachments.getAttachmentMetadata!;
    const target = mediaType.value;

    it("routes media through action attachment uploads", () => {
        expect(
            attachments.canMaterializeAttachment?.(
                {
                    id: "local-id",
                    type: "image/png",
                },
                { target }
            )
        ).toBe(false);
    });

    it("uploads media during action execution and returns a tokenless mapping", async () => {
        const temporaryReference = {
            ...mediaReference,
            reference: {
                ...mediaReference.reference,
                mediaSetViewItem: {
                    ...mediaId,
                    token: "temporary-token",
                },
            },
        };
        mediaMocks.uploadMedia.mockResolvedValue(temporaryReference);
        ontologyMocks.applyWithOverrides.mockResolvedValue({
            operationId: "operation-1",
            validation: { result: "VALID" },
            edits: {
                type: "edits",
                edits: [],
            },
        });
        const blob = new Blob(["image"], {
            type: "image/png",
        });
        const attachment = {
            id: "local-id",
            name: "image.png",
            type: "image/png",
        };

        await expect(
            adapter.applyAction(
                "createMedia",
                { media: attachment },
                {
                    objects: {},
                    attachmentUploads: [
                        {
                            attachment,
                            target,
                            blob,
                        },
                    ],
                }
            )
        ).resolves.toEqual({
            attachmentIdMappings: [
                {
                    localId: "local-id",
                    remoteId: encodeFoundryMediaId(mediaId),
                },
            ],
        });
        expect(ontologyMocks.applyWithOverrides.mock.calls[0]?.[3]).toMatchObject({
            request: {
                parameters: {
                    media: temporaryReference,
                },
            },
        });
    });

    it("reads confirmed media through its object property source", async () => {
        const id = encodeFoundryMediaId(mediaId);
        const attachment = {
            id,
            type: "image/png",
            source: {
                objectType: "Task",
                primaryKey: "task-1",
                property: "media",
            },
        };
        ontologyMocks.getMediaContent.mockResolvedValue(new Response(new Blob(["image"])));
        ontologyMocks.getMediaMetadata.mockResolvedValue({
            sizeBytes: 5,
            mediaType: "image/png",
            path: undefined,
        });

        await expect(attachments.getAttachmentContent(attachment).then((blob) => blob.text())).resolves.toBe(
            "image"
        );
        await expect(
            getAttachmentMetadata(attachment, ["size", "type", "name"])
        ).resolves.toEqual({
            size: 5,
            type: "image/png",
            name: undefined,
        });
        expect(ontologyMocks.getMediaContent).toHaveBeenCalledWith(
            expect.anything(),
            "ri.ontology.main.1",
            "Task",
            "task-1",
            "media",
            { preview: true }
        );
    });

    it("pushes image dimension selection into media set metadata", async () => {
        const attachment = {
            id: encodeFoundryMediaId(mediaId),
            type: "image/png",
        };
        mediaMocks.metadata.mockResolvedValue({
            type: "imagery",
            sizeBytes: 5,
            dimensions: { width: 800, height: 600 },
            bands: [],
            attributes: {},
        });

        await expect(
            getAttachmentMetadata(attachment, ["dimensions"])
        ).resolves.toEqual({
            type: "image/png",
            size: 5,
            dimensions: { width: 800, height: 600 },
        });
        expect(mediaMocks.metadata).toHaveBeenCalledWith(
            expect.anything(),
            mediaId.mediaSetRid,
            mediaId.mediaItemRid,
            { preview: true }
        );
        expect(ontologyMocks.getMediaMetadata).not.toHaveBeenCalled();
    });

    it("resolves inline media type without a Foundry request", async () => {
        const attachment = {
            id: encodeFoundryMediaId(mediaId),
            type: "image/png",
        };

        await expect(
            getAttachmentMetadata(attachment, ["type"])
        ).resolves.toEqual({
            type: "image/png",
        });
        expect(mediaMocks.metadata).not.toHaveBeenCalled();
        expect(ontologyMocks.getMediaMetadata).not.toHaveBeenCalled();
    });
});
