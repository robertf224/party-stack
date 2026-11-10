import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import { makeReplicaAttachments } from "../../../../ontology-replica/lib/attachments/service.js";
import { createLiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
import type { BlobManagerService } from "../../../../ontology-replica/lib/attachments/manager.js";
import type { LiveOntologyAttachments } from "./createLiveOntologyAttachments.js";
import type { AttachmentMetadataField } from "./types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type * as v from "@party-stack/ontology-spec/values";

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
    for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});
const testAttachments = async (options: { ir: OntologyIR; blobManager: BlobManagerService }) => {
    const scope = Effect.runSync(Scope.make());
    scopes.push(scope);
    const attachments = await Effect.runPromise(
        Scope.provide(makeReplicaAttachments({ ir: options.ir, manager: options.blobManager }), scope)
    );
    return createLiveOntologyAttachments({ attachments, scope, run: (work) => Effect.runPromise(work) });
};

describe("attachment metadata", () => {
    it("only exposes dimensions for image selections", () => {
        expectTypeOf<AttachmentMetadataField<"application/pdf">>().toEqualTypeOf<"size" | "type" | "name">();
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
            expectTypeOf(image.attachment).toEqualTypeOf<v.attachment<"image/png" | "image/jpeg">>();

            const images = await attachments.create(new Blob(), {
                target: {
                    kind: "objectProperty",
                    objectType: "Document",
                    property: "images",
                },
            });
            expectTypeOf(images.attachment).toEqualTypeOf<v.attachment<"image/png">>();

            const parameter = await attachments.create(new Blob(), {
                target: {
                    kind: "actionParameter",
                    actionType: "upload",
                    parameter: "image",
                },
            });
            expectTypeOf(parameter.attachment).toEqualTypeOf<v.attachment<"image/jpeg">>();

            const targetless = await attachments.create(new Blob());
            expectTypeOf(targetless.attachment).toEqualTypeOf<v.attachment>();
        };
        expectTypeOf(check).toBeFunction();
    });

    it("delegates missing selected fields to the blob manager", async () => {
        const metadata = vi.fn(() =>
            Effect.succeed({
                id: "image-1",
                size: 10,
                dimensions: { width: 800, height: 600 },
            })
        );
        const attachments = await testAttachments({
            ir: {
                types: [],
                objectTypes: [],
                linkTypes: [],
                actionTypes: [],
                queryFunctionTypes: [],
            } satisfies OntologyIR,
            blobManager: { metadata } as unknown as BlobManagerService,
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
