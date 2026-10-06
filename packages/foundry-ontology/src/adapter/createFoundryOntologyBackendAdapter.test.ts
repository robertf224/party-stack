import { o } from "@party-stack/ontology";
import { Temporal } from "temporal-polyfill";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OntologyClient } from "@party-stack/foundry-client";
import {
    createFoundryOntologyBackend,
    createFoundryOntologyBackendAdapter,
    isFoundryNotFoundError,
} from "./createFoundryOntologyBackendAdapter.js";
import { encodeFoundryMediaId } from "./foundryMediaId.js";

const mediaMocks = vi.hoisted(() => ({
    metadata: vi.fn(),
    uploadMedia: vi.fn(),
}));
const attachmentMocks = vi.hoisted(() => ({
    get: vi.fn(),
    upload: vi.fn(),
    uploadWithRid: vi.fn(),
}));
const ontologyMocks = vi.hoisted(() => ({
    applyWithOverrides: vi.fn(),
    getActionType: vi.fn(),
    getMediaContent: vi.fn(),
    getMediaMetadata: vi.fn(),
}));
const metadataMocks = vi.hoisted(() => ({
    bulkLoadOntologyEntities: vi.fn(),
}));

vi.mock("@osdk/foundry.mediasets", () => ({
    MediaSets: mediaMocks,
}));
vi.mock("@osdk/client.unstable", () => ({
    bulkLoadOntologyEntities: metadataMocks.bulkLoadOntologyEntities,
}));
vi.mock("@osdk/foundry.ontologies", async (importOriginal) => {
    const original = await importOriginal<typeof import("@osdk/foundry.ontologies")>();
    return {
        ...original,
        Actions: {
            ...original.Actions,
            applyWithOverrides: ontologyMocks.applyWithOverrides,
        },
        Attachments: {
            ...original.Attachments,
            get: attachmentMocks.get,
            upload: attachmentMocks.upload,
            uploadWithRid: attachmentMocks.uploadWithRid,
        },
        ActionTypesV2: {
            ...original.ActionTypesV2,
            get: ontologyMocks.getActionType,
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

describe("Foundry action execution time overrides", () => {
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
                    name: "setTimestamp",
                    displayName: "Set timestamp",
                    parameters: [
                        {
                            name: "__now",
                            displayName: "Current time",
                            type: o.timestamp({}),
                            defaultValue: o.Expression.now({}),
                        },
                    ],
                    logic: [],
                },
            ],
            queryFunctionTypes: [],
        },
    });
    const isoInstant = "2026-09-17T20:21:00Z";
    const temporalLike = {
        toString: () => isoInstant,
    };

    it.each([
        ["Temporal.Instant", Temporal.Instant.from(isoInstant)],
        ["Date", new Date(isoInstant)],
        ["Temporal-like value from another module", temporalLike],
    ])("serializes a %s as a raw ISO instant", async (_description, value) => {
        expect(temporalLike).not.toBeInstanceOf(Temporal.Instant);
        ontologyMocks.applyWithOverrides.mockResolvedValue({
            operationId: "operation-1",
            validation: { result: "VALID" },
            edits: {
                type: "edits",
                edits: [],
            },
        });

        await adapter.applyAction("setTimestamp", { __now: value }, { objects: {} });

        expect(ontologyMocks.applyWithOverrides.mock.calls[0]?.[3]).toMatchObject({
            overrides: {
                actionExecutionTime: isoInstant,
            },
        });
    });

    it("rejects an invalid execution time before making a Foundry request", async () => {
        await expect(
            adapter.applyAction(
                "setTimestamp",
                { __now: "not an ISO instant" },
                { objects: {} }
            )
        ).rejects.toThrow(
            "Invalid action execution time: expected a Date or Temporal-like ISO instant."
        );
        expect(ontologyMocks.applyWithOverrides).not.toHaveBeenCalled();
    });
});

describe("Foundry action API names", () => {
    it.each([
        [
            "createWarrantySubmissionForBBStreamline",
            "create-warranty-submission-for-b-b-streamline",
        ],
        [
            "com.palantirfoundry.valinorEnterprises.streamline.completeTask",
            "com.palantirfoundry.valinor-enterprises.streamline.complete-task",
        ],
    ])("applies %s using the exact reversible API name", async (name, apiName) => {
        ontologyMocks.applyWithOverrides.mockResolvedValue({
            operationId: "operation-1",
            validation: { result: "VALID" },
            edits: {
                type: "edits",
                edits: [],
            },
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
                        name,
                        displayName: "Action",
                        parameters: [],
                        logic: [],
                    },
                ],
                queryFunctionTypes: [],
            },
            live: false,
        });

        await adapter.applyAction(name, {}, { objects: {} });

        expect(ontologyMocks.applyWithOverrides.mock.calls[0]?.[2]).toBe(apiName);
    });
});

describe("Foundry live behavior", () => {
    const ir = {
        types: [],
        objectTypes: [
            {
                name: "Task",
                displayName: "Task",
                pluralDisplayName: "Tasks",
                primaryKey: "id",
                properties: [
                    {
                        name: "id",
                        displayName: "ID",
                        type: o.string({}),
                    },
                ],
            },
        ],
        linkTypes: [],
        actionTypes: [
            {
                name: "updateTask",
                displayName: "Update task",
                parameters: [],
                logic: [],
            },
        ],
        queryFunctionTypes: [],
    };

    beforeEach(() => {
        ontologyMocks.applyWithOverrides.mockResolvedValue({
            operationId: "operation-1",
            validation: { result: "VALID" },
            edits: {
                type: "edits",
                edits: [
                    {
                        type: "modifyObject",
                        objectType: "Task",
                    },
                ],
            },
        });
    });

    it("waits for edited collections by default", async () => {
        const awaitOperationId = vi.fn(() => Promise.resolve());
        const adapter = createFoundryOntologyBackendAdapter({
            client: {
                ontologyRid: "ri.ontology.main.1",
            } as OntologyClient,
            ir,
        });

        expect(adapter.live).toBe(true);
        await adapter.applyAction("updateTask", {}, {
            objects: {
                Task: {
                    utils: { awaitOperationId },
                } as never,
            },
        });

        expect(awaitOperationId).toHaveBeenCalledWith("operation-1");
    });

    it("returns after backend acceptance when live is false", async () => {
        const awaitOperationId = vi.fn(() => Promise.resolve());
        const adapter = createFoundryOntologyBackendAdapter({
            client: {
                ontologyRid: "ri.ontology.main.1",
            } as OntologyClient,
            ir,
            live: false,
        });

        expect(adapter.live).toBe(false);
        await adapter.applyAction("updateTask", {}, {
            objects: {
                Task: {
                    utils: { awaitOperationId },
                } as never,
            },
        });

        expect(awaitOperationId).not.toHaveBeenCalled();
    });

    it("forwards live through the backend provider", async () => {
        const backend = createFoundryOntologyBackend({
            client: {
                ontologyRid: "ri.ontology.main.1",
            } as OntologyClient,
            live: false,
        });

        await expect(backend(ir, {})).resolves.toMatchObject({
            name: "foundry",
            live: false,
        });
    });
});

describe("Foundry attachments", () => {
    const attachmentType = o.attachment({
        meta: { foundry: { kind: "attachment" } },
    });
    const adapter = createFoundryOntologyBackendAdapter({
        client: {
            ontologyRid: "ri.ontology.main.1",
        } as OntologyClient,
        ir: {
            types: [],
            objectTypes: [],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
        },
    });
    const materializeAttachment = adapter.attachments!.materializeAttachment!;
    const target = attachmentType.value;
    const blob = new Blob(["attachment"], { type: "text/plain" });

    it("lets Foundry assign a canonical RID for an opaque local ID", async () => {
        attachmentMocks.upload.mockResolvedValue({
            rid: "ri.attachments.main.attachment.remote",
        });

        await expect(
            materializeAttachment(
                {
                    id: "local-id",
                    type: "text/plain",
                },
                blob,
                { target }
            )
        ).resolves.toEqual({
            id: "ri.attachments.main.attachment.remote",
            type: "text/plain",
        });
        expect(attachmentMocks.upload).toHaveBeenCalledWith(expect.anything(), blob, {
            filename: "",
        });
        expect(attachmentMocks.get).not.toHaveBeenCalled();
        expect(attachmentMocks.uploadWithRid).not.toHaveBeenCalled();
    });

    it("preserves an existing Foundry attachment RID", async () => {
        attachmentMocks.get.mockResolvedValue({
            rid: "ri.attachments.main.attachment.existing",
        });

        await expect(
            materializeAttachment(
                {
                    id: "ri.attachments.main.attachment.existing",
                },
                blob,
                { target }
            )
        ).resolves.toBeUndefined();
        expect(attachmentMocks.upload).not.toHaveBeenCalled();
        expect(attachmentMocks.uploadWithRid).not.toHaveBeenCalled();
    });

    it("uploads a missing preassigned Foundry attachment RID", async () => {
        attachmentMocks.get.mockRejectedValue({
            statusCode: 404,
        });

        await expect(
            materializeAttachment(
                {
                    id: "ri.attachments.main.attachment.missing",
                },
                blob,
                { target }
            )
        ).resolves.toBeUndefined();
        expect(attachmentMocks.uploadWithRid).toHaveBeenCalledWith(
            expect.anything(),
            "ri.attachments.main.attachment.missing",
            blob,
            {
                filename: "",
                preview: true,
            }
        );
    });

    it("does not treat other lookup failures as a missing attachment", async () => {
        const error = new Error("Foundry unavailable");
        attachmentMocks.get.mockRejectedValue(error);

        await expect(
            materializeAttachment(
                {
                    id: "ri.attachments.main.attachment.existing",
                },
                blob,
                { target }
            )
        ).rejects.toBe(error);
        expect(attachmentMocks.upload).not.toHaveBeenCalled();
        expect(attachmentMocks.uploadWithRid).not.toHaveBeenCalled();
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
        meta: { foundry: { kind: "media" } },
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
                        {
                            name: "caption",
                            displayName: "Caption",
                            type: o.optional({ type: o.string({}) }),
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
                { media: attachment, caption: null },
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
                    caption: null,
                },
            },
        });
    });

    it("validates without executing or uploading media", async () => {
        ontologyMocks.applyWithOverrides.mockResolvedValue({
            validation: {
                result: "INVALID",
                submissionCriteria: [
                    {
                        result: "INVALID",
                        configuredFailureMessage: "Only administrators may submit.",
                    },
                ],
                parameters: {},
            },
        });

        await expect(
            adapter.validateAction!(
                "createMedia",
                {
                    media: {
                        id: encodeFoundryMediaId(mediaId),
                        type: "image/png",
                    },
                },
                {
                    objects: {},
                }
            )
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [{ message: "Only administrators may submit." }],
            },
        });
        const request = ontologyMocks.applyWithOverrides.mock.calls[0]?.[3] as unknown as {
            request: {
                options: {
                    mode: string;
                };
            };
        };
        expect(request.request.options).toEqual({
            mode: "VALIDATE_ONLY",
        });
        expect(mediaMocks.uploadMedia).not.toHaveBeenCalled();
    });

    it("proves impossible submission criteria without validating incomplete parameters", async () => {
        ontologyMocks.getActionType.mockResolvedValue({
            rid: "ri.action-type.main.action-type.1",
        });
        metadataMocks.bulkLoadOntologyEntities.mockResolvedValue({
            actionTypes: [
                {
                    actionType: {
                        actionTypeLogic: {
                            validation: {
                                actionTypeLevelValidation: {
                                    rules: {
                                        adminOnly: {
                                            condition: {
                                                type: "comparison",
                                                comparison: {
                                                    left: {
                                                        type: "staticValue",
                                                        staticValue: {
                                                            type: "string",
                                                            string: "user",
                                                        },
                                                    },
                                                    operator: "EQUALS",
                                                    right: {
                                                        type: "staticValue",
                                                        staticValue: {
                                                            type: "string",
                                                            string: "admin",
                                                        },
                                                    },
                                                },
                                            },
                                            displayMetadata: {
                                                failureMessage: "Only administrators may submit.",
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            ],
        });

        await expect(
            adapter.validateActionDraft!("createMedia", {}, {
                objects: {},
                context: {
                    user: "user-1",
                },
                knownParameters: [],
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [
                    {
                        message:
                            "Impossible submission criterion: Only administrators may submit.",
                    },
                ],
            },
        });
        expect(ontologyMocks.applyWithOverrides).not.toHaveBeenCalled();
    });

    it("reports uncertain draft validation without a context user", async () => {
        await expect(
            adapter.validateActionDraft!("createMedia", {}, {
                objects: {},
                knownParameters: [],
            })
        ).resolves.toEqual({
            certain: false,
        });
        expect(ontologyMocks.getActionType).not.toHaveBeenCalled();
        expect(metadataMocks.bulkLoadOntologyEntities).not.toHaveBeenCalled();
    });

    it("reports a known required parameter as missing", async () => {
        await expect(
            adapter.validateActionDraft!("createMedia", {}, {
                objects: {},
                context: {
                    user: "user-1",
                },
                knownParameters: ["media"],
            })
        ).resolves.toEqual({
            certain: true,
            value: {
                kind: "err",
                value: [
                    {
                        message: 'Required action parameter "media" is missing.',
                        path: ["media"],
                    },
                ],
            },
        });
        expect(metadataMocks.bulkLoadOntologyEntities).not.toHaveBeenCalled();
        expect(ontologyMocks.applyWithOverrides).not.toHaveBeenCalled();
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
        await expect(getAttachmentMetadata(attachment, ["size", "type", "name"])).resolves.toEqual({
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

        await expect(getAttachmentMetadata(attachment, ["dimensions"])).resolves.toEqual({
            type: "image/png",
            size: 5,
            dimensions: { width: 800, height: 600 },
        });
        expect(mediaMocks.metadata).toHaveBeenCalledWith(
            expect.anything(),
            mediaId.mediaSetRid,
            mediaId.mediaItemRid
        );
        expect(ontologyMocks.getMediaMetadata).not.toHaveBeenCalled();
    });

    it("resolves inline media type without a Foundry request", async () => {
        const attachment = {
            id: encodeFoundryMediaId(mediaId),
            type: "image/png",
        };

        await expect(getAttachmentMetadata(attachment, ["type"])).resolves.toEqual({
            type: "image/png",
        });
        expect(mediaMocks.metadata).not.toHaveBeenCalled();
        expect(ontologyMocks.getMediaMetadata).not.toHaveBeenCalled();
    });
});
