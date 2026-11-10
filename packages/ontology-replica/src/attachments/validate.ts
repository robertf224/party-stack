import { BackendError } from "@party-stack/ontology-backend";
import { ImageMediaTypeOptions } from "@party-stack/ontology-spec/constants";
import { Effect } from "effect";
import type { AttachmentTypeDef } from "@party-stack/ontology-spec";
import type { ByteSource } from "@party-stack/ontology-storage/blobs";

export const invalidAttachment = (message: string) =>
    new BackendError({
        operation: "attachment.create",
        kind: "InvalidRequest",
        message,
        retryable: false,
        actionOutcome: "not-committed",
    });
export const attachmentSizeInRange = (size: number, range: { min?: number; max?: number }) =>
    (range.min === undefined || size >= range.min) && (range.max === undefined || size <= range.max);

export const validateAttachmentSource = Effect.fnUntraced(function* (
    source: ByteSource,
    target?: AttachmentTypeDef
) {
    const constraint = target?.constraint;
    if (constraint?.size && source.size !== undefined && !attachmentSizeInRange(source.size, constraint.size))
        return yield* invalidAttachment(`Attachment size ${source.size} is outside the allowed range.`);
    const content = constraint?.content;
    if (
        content?.kind === "image" &&
        !(content.value.mediaTypes ?? ImageMediaTypeOptions.map((option) => option.value)).some(
            (mediaType) => mediaType === source.type
        )
    )
        return yield* invalidAttachment(
            `Attachment media type "${source.type || "(empty)"}" is not allowed by the target.`
        );
});
