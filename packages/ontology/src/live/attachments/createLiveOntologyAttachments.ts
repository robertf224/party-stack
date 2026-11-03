import type { AttachmentMetadata, AttachmentMetadataSelection, PartialAttachmentMetadata } from "./types.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { ReplicaAttachments } from "@party-stack/ontology-replica";
import type { OntologyAttachmentCreateTarget } from "@party-stack/ontology-spec/utils";
import type * as v from "@party-stack/ontology-spec/values";
import type { ByteInput, ReadableByteInput, ByteSource } from "@party-stack/ontology-storage/blobs";
import type { Effect } from "effect";

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
    source: (attachment: v.attachment, options?: { readonly signal?: AbortSignal }) => Promise<ByteSource>;
}

/** Typed Promise boundary. Validation, staging, upload and aliases are native Replica behavior. */
export function createLiveOntologyAttachments<
    Ontology extends AttachmentOntologyDefinition = AttachmentOntologyDefinition,
>(options: {
    readonly attachments: ReplicaAttachments;
    readonly run: <A>(work: Effect.Effect<A, BackendError>, signal?: AbortSignal) => Promise<A>;
}): LiveOntologyAttachments<Ontology> {
    return {
        create: (async (input, settings) => {
            const created = await options.run(options.attachments.create(input, settings));
            const isMaterialized = created.isMaterialized ? options.run(created.isMaterialized) : undefined;
            void isMaterialized?.catch(() => undefined);
            return { attachment: created.attachment, ...(isMaterialized ? { isMaterialized } : {}) };
        }) as LiveOntologyAttachments<Ontology>["create"],
        source: (value, settings) =>
            options.run(options.attachments.source(value, settings), settings?.signal),
        blob: (value) => options.run(options.attachments.blob(value)),
        metadata: ((
            value: v.attachment,
            settings?: { select: readonly (keyof PartialAttachmentMetadata)[] }
        ) =>
            options.run(
                options.attachments.metadata(value, settings)
            )) as LiveOntologyAttachments<Ontology>["metadata"],
    };
}
