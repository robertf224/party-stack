import { invariant } from "@bobbyfidz/panic";
import type { BlobManager } from "@party-stack/blobs";
import { getTargetValueType } from "../utils/types.js";
import * as v from "../utils/values.js";
import type { OntologyAttachmentsAdapter } from "./OntologyAdapter.js";
import type { OntologyIR } from "../ir/index.js";
import type { OntologyAttachmentCreateTarget } from "../utils/targets.js";

export interface LiveOntologyEagerAttachmentCreation {
    attachment: v.attachment;
    isMaterialized?: Promise<void>;
}

interface LiveOntologyAttachmentCreateOptions {
    target?: OntologyAttachmentCreateTarget;
    eager?: boolean;
}

type LiveOntologyAttachmentCreateResult<Options extends LiveOntologyAttachmentCreateOptions | undefined> = {
    attachment: v.attachment;
} & (Options extends { eager: true } ? { isMaterialized?: Promise<void> } : { isMaterialized?: never });

export interface LiveOntologyAttachments {
    create: <Options extends LiveOntologyAttachmentCreateOptions | undefined = undefined>(
        blob: Blob | File,
        opts?: Options
    ) => Promise<LiveOntologyAttachmentCreateResult<Options>>;
    metadata: (
        attachment: v.attachment
    ) => Promise<v.attachment & { size: number; type: string; name: string }>;
    blob: (attachment: v.attachment) => Promise<Blob>;
}

export function createLiveOntologyAttachments(opts: {
    ir: OntologyIR;
    attachmentsAdapter: OntologyAttachmentsAdapter;
    blobManager: BlobManager;
}): LiveOntologyAttachments {
    const { attachmentsAdapter, blobManager } = opts;

    const create = async <Options extends LiveOntologyAttachmentCreateOptions | undefined = undefined>(
        blob: Blob | File,
        createOpts?: Options
    ): Promise<LiveOntologyAttachmentCreateResult<Options>> => {
        const normalizedOpts: LiveOntologyAttachmentCreateOptions = createOpts ?? {};
        const targetType = normalizedOpts.target
            ? getTargetValueType(opts.ir, normalizedOpts.target)
            : undefined;
        invariant(
            targetType === undefined || targetType.kind === "attachment",
            "Target is not an attachment."
        );
        const id =
            targetType?.kind === "attachment" && attachmentsAdapter.generateAttachmentId
                ? await attachmentsAdapter.generateAttachmentId(blob, {
                      target: targetType.value,
                  })
                : crypto.randomUUID();
        const ref = await blobManager.stage(id, blob);
        const attachment = {
            id: ref.id,
            size: ref.size,
            type: ref.type,
            name: ref.name,
        };
        const materializeAttachment = attachmentsAdapter.materializeAttachment;
        if (normalizedOpts.eager && materializeAttachment) {
            const promise = blobManager.withUploadTracking(ref.id, (blob) =>
                materializeAttachment(attachment, blob, {
                    target: targetType?.kind === "attachment" ? targetType.value : undefined,
                })
            );
            void promise.catch(() => undefined);
            return {
                attachment,
                isMaterialized: promise,
            } as unknown as LiveOntologyAttachmentCreateResult<Options>;
        }
        return { attachment } as LiveOntologyAttachmentCreateResult<Options>;
    };

    return {
        create,
        metadata: (attachment) =>
            blobManager.metadata(attachment.id, { meta: { source: attachment.source } }),
        blob: (attachment) => blobManager.blob(attachment.id, { meta: { source: attachment.source } }),
    };
}
