import { invariant } from "@bobbyfidz/panic";
import { ImageMediaTypeOptions } from "@party-stack/ontology-spec/constants";
import { getTargetValueType } from "@party-stack/ontology-spec/utils";
import * as v from "@party-stack/ontology-spec/values";
import {
    attachmentByteSource,
    type ByteInput,
    type ReadableByteInput,
} from "@party-stack/ontology-storage/blobs";
import type { BlobManager } from "../../runtime/blobs/types.js";
import type { AttachmentMetadata, AttachmentMetadataSelection, PartialAttachmentMetadata } from "./types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { OntologyAttachmentCreateTarget } from "@party-stack/ontology-spec/utils";

export interface LiveOntologyEagerAttachmentCreation {
    attachment: v.attachment;
    isMaterialized?: Promise<void>;
}

interface LiveOntologyAttachmentCreateOptions {
    /**
     * An opaque ID to use instead of generating one.
     */
    id?: string;
    target?: OntologyAttachmentCreateTarget;
    eager?: boolean;
}

interface AttachmentOntologyDefinition {
    objectTypes: Record<string, Record<string, unknown>>;
    actionTypes: Record<
        string,
        {
            parameters: Record<string, unknown>;
        }
    >;
}

type ExtractAttachment<Value> =
    Value extends v.attachment<infer Type>
        ? v.attachment<Type>
        : NonNullable<Value> extends ReadonlyArray<infer Element>
          ? ExtractAttachment<Element>
          : never;

type AttachmentAtTarget<
    Ontology extends AttachmentOntologyDefinition,
    Target,
> = string extends keyof Ontology["objectTypes"]
    ? v.attachment
    : Target extends {
            kind: "objectProperty";
            objectType: infer ObjectType;
            property: infer Property;
        }
      ? ObjectType extends keyof Ontology["objectTypes"]
          ? Property extends keyof Ontology["objectTypes"][ObjectType]
              ? ExtractAttachment<Ontology["objectTypes"][ObjectType][Property]>
              : never
          : never
      : Target extends {
              kind: "actionParameter";
              actionType: infer ActionType;
              parameter: infer Parameter;
          }
        ? ActionType extends keyof Ontology["actionTypes"]
            ? Parameter extends keyof Ontology["actionTypes"][ActionType]["parameters"]
                ? ExtractAttachment<Ontology["actionTypes"][ActionType]["parameters"][Parameter]>
                : never
            : never
        : v.attachment;

type LiveOntologyAttachmentCreateResult<
    Ontology extends AttachmentOntologyDefinition,
    Options extends LiveOntologyAttachmentCreateOptions | undefined,
> = {
    attachment: Options extends { target: infer Target }
        ? AttachmentAtTarget<Ontology, Target>
        : v.attachment;
} & (Options extends { eager: true } ? { isMaterialized?: Promise<void> } : { isMaterialized?: never });

function satisfiesRange(value: number, range: { min?: number; max?: number }): boolean {
    return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}

export interface LiveOntologyAttachments<
    Ontology extends AttachmentOntologyDefinition = AttachmentOntologyDefinition,
> {
    create: <const Options extends LiveOntologyAttachmentCreateOptions | undefined = undefined>(
        input: ByteInput | ReadableByteInput,
        opts?: Options
    ) => Promise<LiveOntologyAttachmentCreateResult<Ontology, Options>>;
    metadata: {
        <Type extends string>(attachment: v.attachment<Type>): Promise<AttachmentMetadata<Type>>;
        <Type extends string, const Selection extends AttachmentMetadataSelection<Type>>(
            attachment: v.attachment<Type>,
            options: { select: Selection }
        ): Promise<AttachmentMetadata<Type, Selection[number]>>;
    };
    blob: (attachment: v.attachment) => Promise<Blob>;
    source: (
        attachment: v.attachment,
        options?: { readonly signal?: AbortSignal }
    ) => Promise<import("@party-stack/ontology-storage/blobs").ByteSource>;
}

export function createLiveOntologyAttachments<
    Ontology extends AttachmentOntologyDefinition = AttachmentOntologyDefinition,
>(opts: {
    ir: OntologyIR;
    stageAttachment?: (
        value: v.attachment,
        bytes: ByteInput,
        target?: import("@party-stack/ontology-spec").AttachmentTypeDef
    ) => Promise<v.attachment>;
    blobManager: BlobManager;
}): LiveOntologyAttachments<Ontology> {
    const { stageAttachment, blobManager } = opts;

    const create = async <const Options extends LiveOntologyAttachmentCreateOptions | undefined = undefined>(
        input: ByteInput | ReadableByteInput,
        createOpts?: Options
    ): Promise<LiveOntologyAttachmentCreateResult<Ontology, Options>> => {
        const blob = attachmentByteSource(input);
        const normalizedOpts: LiveOntologyAttachmentCreateOptions = createOpts ?? {};
        const targetType = normalizedOpts.target
            ? getTargetValueType(opts.ir, normalizedOpts.target)
            : undefined;
        invariant(
            targetType === undefined || targetType.kind === "attachment",
            "Target is not an attachment."
        );
        const constraint = targetType?.kind === "attachment" ? targetType.value.constraint : undefined;
        invariant(
            !constraint?.size || blob.size === undefined || satisfiesRange(blob.size, constraint.size),
            `Attachment size ${blob.size} is outside the allowed range.`
        );
        const content = constraint?.content;
        if (content?.kind === "image") {
            invariant(
                content.value.mediaTypes
                    ? content.value.mediaTypes.some((mediaType) => mediaType === blob.type)
                    : ImageMediaTypeOptions.some((option) => option.value === blob.type),
                `Attachment media type "${blob.type || "(empty)"}" is not allowed by the target.`
            );
            // TODO: Validate image dimensions once runtimes expose a portable media-inspection capability.
        }
        const id = normalizedOpts.id ?? crypto.randomUUID();
        await blobManager.stage(id, blob);
        if (constraint?.size && blob.size === undefined) {
            const metadata = await blobManager.metadata(id);
            invariant(
                metadata.size !== undefined && satisfiesRange(metadata.size, constraint.size),
                "Attachment size is outside the allowed range."
            );
        }
        const attachment: v.attachment = {
            id,
            type: blob.type,
        };
        if (normalizedOpts.eager && stageAttachment) {
            const promise = blobManager
                .source(id)
                .then((storedBlob) =>
                    stageAttachment(
                        attachment,
                        storedBlob,
                        targetType?.kind === "attachment" ? targetType.value : undefined
                    )
                )
                .then(async (materialized) => {
                    if (materialized) {
                        if (materialized.id !== id) await blobManager.bindRemoteId(id, materialized.id);
                        Object.assign(attachment, materialized);
                    }
                });
            void promise.catch(() => undefined);
            return {
                attachment,
                isMaterialized: promise,
            } as unknown as LiveOntologyAttachmentCreateResult<Ontology, Options>;
        }
        return {
            attachment,
        } as LiveOntologyAttachmentCreateResult<Ontology, Options>;
    };

    const blob = (attachment: v.attachment) =>
        blobManager.read(attachment.id, {
            meta: { attachment },
        });

    async function metadata<Type extends string>(
        attachment: v.attachment<Type>
    ): Promise<AttachmentMetadata<Type>>;
    async function metadata<Type extends string, const Selection extends AttachmentMetadataSelection<Type>>(
        attachment: v.attachment<Type>,
        options: { select: Selection }
    ): Promise<AttachmentMetadata<Type, Selection[number]>>;
    async function metadata<Type extends string>(
        attachment: v.attachment<Type>,
        options?: { select: readonly (keyof PartialAttachmentMetadata)[] }
    ): Promise<v.attachment<Type> & PartialAttachmentMetadata<Type>> {
        const selection = options?.select ?? ["size", "type", "name"];
        const resolved = await blobManager.metadata(attachment.id, {
            meta: { attachment },
            select: selection,
        });
        if (selection.includes("dimensions") && resolved.dimensions === null) {
            throw new Error(`Dimensions are unavailable for attachment "${attachment.id}".`);
        }
        const { name, ...metadata } = resolved;
        return {
            ...attachment,
            ...metadata,
            ...(typeof name === "string" ? { name } : {}),
        } as v.attachment<Type> & PartialAttachmentMetadata<Type>;
    }

    return {
        create,
        metadata,
        blob,
        source: (attachment, options) =>
            blobManager.source(attachment.id, { signal: options?.signal, meta: { attachment } }),
    };
}
