import { invariant } from "@bobbyfidz/panic";
import type { BlobManager } from "@party-stack/blobs";
import { getTargetValueType, type OntologyPropertyTarget } from "../utils/types.js";
import * as v from "../utils/values.js";
import type { OntologyAttachmentsAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";

export interface LiveOntologyAttachments {
    create: (
        blob: Blob | File,
        opts: {
            target: OntologyPropertyTarget;
            eager?: boolean;
        }
    ) => Promise<v.attachment>;
    metadata: (
        attachment: v.attachment
    ) => Promise<v.attachment & { size: number; type: string; name: string }>;
    blob: (attachment: v.attachment) => Promise<Blob>;
    lease: (attachment: v.attachment) => () => void;
}

export function createLiveOntologyAttachments(opts: {
    ir: OntologyIR;
    attachmentsAdapter: OntologyAttachmentsAdapter;
    blobManager: BlobManager;
}): LiveOntologyAttachments {
    const { attachmentsAdapter, blobManager } = opts;

    return {
        create: async (blob, { target, eager }) => {
            const targetType = getTargetValueType(opts.ir, target);
            invariant(
                targetType.kind === "attachment",
                `Target property ${target.objectType}.${target.property} is not an attachment.`
            );
            const id = await attachmentsAdapter.generateAttachmentId(blob, {
                target: targetType.value,
            });
            const ref = await blobManager.stage(id, blob);
            const attachment = {
                id: ref.id,
                size: ref.size,
                type: ref.type,
                name: ref.name,
            };
            const materializeAttachment = attachmentsAdapter.materializeAttachment;
            if (eager && materializeAttachment) {
                await blobManager.withUploadTracking(ref.id, (blob) =>
                    materializeAttachment(attachment, blob, {
                        target: targetType.value,
                    })
                );
            }
            return attachment;
        },
        metadata: (attachment) =>
            blobManager.metadata(attachment.id, { meta: { source: attachment.source } }),
        blob: (attachment) => blobManager.blob(attachment.id, { meta: { source: attachment.source } }),
        lease: (attachment) => blobManager.lease(attachment.id),
    };
}
