import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { BlobManager } from "@party-stack/blobs";
import { createLiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
import type { LiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
import type { AttachmentMetadataField } from "./types.js";
import type { OntologyIR } from "../../ir/index.js";
import type * as v from "../../utils/values.js";
import type { OntologyAttachmentsAdapter } from "../OntologyBackendAdapter.js";

describe("attachment metadata", () => {
    it("only exposes dimensions for image selections", () => {
        expectTypeOf<AttachmentMetadataField<"application/pdf">>().toEqualTypeOf<
            "size" | "type" | "name"
        >();
        expectTypeOf<AttachmentMetadataField<"image/png">>().toEqualTypeOf<
            "size" | "type" | "name" | "dimensions"
        >();
    });

    it("infers created attachment types from targets", () => {
        type TestOntology = {
            objectTypes: {
                Document: {
                    image: v.attachment<"image/png" | "image/jpeg">;
                    images: Array<v.attachment<"image/png">>;
                    title: string;
                };
            };
            actionTypes: {
                upload: {
                    parameters: {
                        image: v.attachment<"image/jpeg"> | null;
                    };
                };
            };
        };
        const attachments = undefined as unknown as LiveOntologyAttachments<TestOntology>;

        const check = async () => {
            const image = await attachments.create(new Blob(), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "image",
                },
            });
            expectTypeOf(image.attachment).toEqualTypeOf<
                v.attachment<"image/png" | "image/jpeg">
            >();

            const images = await attachments.create(new Blob(), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "images",
                },
            });
            expectTypeOf(images.attachment).toEqualTypeOf<
                v.attachment<"image/png">
            >();

            const parameter = await attachments.create(new Blob(), {
                target: {
                    kind: "actionParameter",
                    actionType: "upload",
                    parameter: "image",
                },
            });
            expectTypeOf(parameter.attachment).toEqualTypeOf<
                v.attachment<"image/jpeg">
            >();

            const targetless = await attachments.create(new Blob());
            expectTypeOf(targetless.attachment).toEqualTypeOf<v.attachment>();
        };
        expectTypeOf(check).toBeFunction();
    });

    it("delegates missing selected fields to the blob manager", async () => {
        const metadata = vi.fn(() =>
            Promise.resolve({
                id: "image-1",
                size: 10,
                dimensions: { width: 800, height: 600 },
            })
        );
        const attachments = createLiveOntologyAttachments({
            ir: {
                types: [],
                objectTypes: [],
                linkTypes: [],
                actionTypes: [],
                queryFunctionTypes: [],
            } satisfies OntologyIR,
            attachmentsAdapter: {} as OntologyAttachmentsAdapter,
            blobManager: { metadata } as unknown as BlobManager,
        });
        const attachment = {
            id: "image-1",
            type: "image/png" as const,
        };

        await expect(
            attachments.metadata(attachment, {
                select: ["type", "dimensions"],
            })
        ).resolves.toMatchObject({
            type: "image/png",
            dimensions: { width: 800, height: 600 },
        });
        expect(metadata).toHaveBeenCalledWith("image-1", {
            meta: { attachment },
            select: ["type", "dimensions"],
        });
    });
});
