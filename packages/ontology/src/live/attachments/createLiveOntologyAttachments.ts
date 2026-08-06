import { invariant } from "@bobbyfidz/panic";
import type { BlobManager } from "@party-stack/blobs";
import { ImageMediaTypeOptions } from "../../ir/generated/constants.js";
import { getTargetValueType } from "../../utils/types.js";
import * as v from "../../utils/values.js";
import type {
    AttachmentMetadata,
    AttachmentMetadataSelection,
    PartialAttachmentMetadata,
} from "./types.js";
import type { OntologyIR } from "../../ir/index.js";
import type { OntologyAttachmentCreateTarget } from "../../utils/targets.js";
import type { OntologyAttachmentsAdapter } from "../OntologyBackendAdapter.js";

export interface LiveOntologyEagerAttachmentCreation {
    attachment: v.attachment;
    isMaterialized?: Promise<void>;
}

interface LiveOntologyAttachmentCreateOptions {
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
              ? ExtractAttachment<
                    Ontology["objectTypes"][ObjectType][Property]
                >
              : never
          : never
      : Target extends {
            kind: "actionParameter";
            actionType: infer ActionType;
            parameter: infer Parameter;
        }
        ? ActionType extends keyof Ontology["actionTypes"]
            ? Parameter extends keyof Ontology["actionTypes"][ActionType]["parameters"]
                ? ExtractAttachment<
                      Ontology["actionTypes"][ActionType]["parameters"][Parameter]
                  >
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
} & (Options extends { eager: true }
    ? { isMaterialized?: Promise<void> }
    : { isMaterialized?: never });

function satisfiesRange(value: number, range: { min?: number; max?: number }): boolean {
    return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
}

export interface LiveOntologyAttachments<
    Ontology extends AttachmentOntologyDefinition = AttachmentOntologyDefinition,
> {
    create: <
        const Options extends LiveOntologyAttachmentCreateOptions | undefined = undefined,
    >(
        blob: Blob | File,
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
}

export function createLiveOntologyAttachments<
    Ontology extends AttachmentOntologyDefinition = AttachmentOntologyDefinition,
>(opts: {
    ir: OntologyIR;
    attachmentsAdapter: OntologyAttachmentsAdapter;
    blobManager: BlobManager;
}): LiveOntologyAttachments<Ontology> {
    const { attachmentsAdapter, blobManager } = opts;

    const create = async <
        const Options extends LiveOntologyAttachmentCreateOptions | undefined = undefined,
    >(
        blob: Blob | File,
        createOpts?: Options
    ): Promise<LiveOntologyAttachmentCreateResult<Ontology, Options>> => {
        const normalizedOpts: LiveOntologyAttachmentCreateOptions =
            createOpts ?? {};
        const targetType = normalizedOpts.target
            ? getTargetValueType(opts.ir, normalizedOpts.target)
            : undefined;
        invariant(
            targetType === undefined || targetType.kind === "attachment",
            "Target is not an attachment."
        );
        const constraint = targetType?.kind === "attachment" ? targetType.value.constraint : undefined;
        invariant(
            !constraint?.size || satisfiesRange(blob.size, constraint.size),
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
        const id =
            targetType?.kind === "attachment" && attachmentsAdapter.generateAttachmentId
                ? await attachmentsAdapter.generateAttachmentId(blob, {
                      target: targetType.value,
                  })
                : crypto.randomUUID();
        await blobManager.stage(id, blob);
        const attachment: v.attachment = {
            id,
            type: blob.type,
        };
        const materializeAttachment = attachmentsAdapter.materializeAttachment;
        const materializeOptions = {
            target: targetType?.kind === "attachment" ? targetType.value : undefined,
        };
        const canMaterialize =
            materializeAttachment &&
            (attachmentsAdapter.canMaterializeAttachment?.(attachment, materializeOptions) ?? true);
        if (normalizedOpts.eager && canMaterialize) {
            const promise = blobManager
                .read(id)
                .then((storedBlob) => materializeAttachment(attachment, storedBlob, materializeOptions))
                .then(async (materialized) => {
                    if (materialized) {
                        if (materialized.id !== id) {
                            await blobManager.bindRemoteId(id, materialized.id);
                        }
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
    async function metadata<
        Type extends string,
        const Selection extends AttachmentMetadataSelection<Type>,
    >(
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
    };
}
