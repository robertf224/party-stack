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
        }
    ) => Promise<v.attachment>;
    metadata: (attachment: v.attachment) => Promise<Required<v.attachment>>;
    blob: (attachment: v.attachment) => Promise<Blob>;
    retain: (attachment: v.attachment) => void;
    release: (attachment: v.attachment) => void;
}

export function createLiveOntologyAttachments(opts: {
    ir: OntologyIR;
    attachmentsAdapter: OntologyAttachmentsAdapter;
    blobManager: BlobManager;
}): LiveOntologyAttachments {
    const { attachmentsAdapter, blobManager } = opts;

    return {
        create: async (blob, { target }) => {
            const targetType = getTargetValueType(opts.ir, target);
            invariant(
                targetType.kind === "attachment",
                `Target property ${target.objectType}.${target.property} is not an attachment.`
            );
            const id = await attachmentsAdapter.generateAttachmentId(blob, {
                target: targetType.value,
            });
            const ref = await blobManager.stage(id, blob);
            return {
                id: ref.id,
                size: ref.size,
                type: ref.type,
                name: ref.name,
            };
        },
        metadata: (attachment) => blobManager.metadata(attachment.id),
        blob: (attachment) => blobManager.blob(attachment.id),
        retain: (attachment) => {
            blobManager.retain(attachment.id);
        },
        release: (attachment) => {
            blobManager.release(attachment.id);
        },
    };
}
