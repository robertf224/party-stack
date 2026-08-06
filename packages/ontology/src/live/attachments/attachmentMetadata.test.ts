import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { BlobManager } from "@party-stack/blobs";
import { createLiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
import type { AttachmentMetadataField } from "./types.js";
import type { OntologyIR } from "../../ir/index.js";
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
