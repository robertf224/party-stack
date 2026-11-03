import { BackendError } from "@party-stack/ontology-backend";
import { ImageMediaTypeOptions } from "@party-stack/ontology-spec/constants";
import { getTargetValueType } from "@party-stack/ontology-spec/utils";
import { attachmentByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Fiber } from "effect";
import type { BlobManagerService } from "./manager.js";
import type { BlobMetadataField, PartialBlobMetadata } from "./types.js";
import type { BackendAttachments } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { OntologyAttachmentCreateTarget } from "@party-stack/ontology-spec/utils";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { ByteInput, ByteSource, ReadableByteInput } from "@party-stack/ontology-storage/blobs";
import type { Scope } from "effect";

export interface AttachmentCreateOptions {
    readonly id?: string;
    readonly target?: OntologyAttachmentCreateTarget;
    readonly eager?: boolean;
}
export interface AttachmentCreation {
    readonly attachment: attachment;
    /** Already running in the replica Scope; observing it does not start another upload. */
    readonly isMaterialized?: Effect.Effect<void, BackendError>;
}
export interface ReplicaAttachments {
    readonly create: (
        input: ByteInput | ReadableByteInput,
        options?: AttachmentCreateOptions
    ) => Effect.Effect<AttachmentCreation, BackendError>;
    /** The caller Scope owns this read, including cold-cache fill before consumption. */
    readonly source: (
        value: attachment,
        options?: { readonly signal?: AbortSignal }
    ) => Effect.Effect<ByteSource, BackendError, Scope.Scope>;
    readonly blob: (value: attachment) => Effect.Effect<Blob, BackendError>;
    readonly metadata: (
        value: attachment,
        options?: { readonly select?: readonly BlobMetadataField[] }
    ) => Effect.Effect<attachment & PartialBlobMetadata, BackendError>;
}
const invalid = (message: string) =>
    new BackendError({ operation: "attachment.create", kind: "InvalidRequest", message, retryable: false });
const missing = () =>
    new BackendError({
        operation: "attachment",
        kind: "NotImplemented",
        message: "Local attachment storage is unavailable.",
        retryable: false,
    });
const inRange = (value: number, range: { min?: number; max?: number }) =>
    (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);

/** Replica-owned lifecycle and IO; the SDK only infers target types and unwraps Effects. */
export const makeReplicaAttachments = Effect.fnUntraced(function* (options: {
    readonly ir: OntologyIR;
    readonly manager?: BlobManagerService;
    readonly stage?: BackendAttachments["stage"];
}): Effect.fn.Return<ReplicaAttachments, never, Scope.Scope> {
    const owner = yield* Effect.scope;
    const requireManager = () => (options.manager ? Effect.succeed(options.manager) : Effect.fail(missing()));
    return {
        create: Effect.fn("Replica.attachments.create")(function* (input, settings) {
            const manager = yield* requireManager();
            const source = yield* Effect.try({
                try: () => attachmentByteSource(input),
                catch: () => invalid("Invalid attachment byte source."),
            });
            const type = yield* Effect.try({
                try: () => (settings?.target ? getTargetValueType(options.ir, settings.target) : undefined),
                catch: () => invalid("Invalid attachment target."),
            });
            if (type && type.kind !== "attachment") return yield* invalid("Target is not an attachment.");
            const constraint = type?.kind === "attachment" ? type.value.constraint : undefined;
            if (constraint?.size && source.size !== undefined && !inRange(source.size, constraint.size))
                return yield* invalid(`Attachment size ${source.size} is outside the allowed range.`);
            const content = constraint?.content;
            if (
                content?.kind === "image" &&
                !(content.value.mediaTypes ?? ImageMediaTypeOptions.map((option) => option.value)).some(
                    (mediaType) => mediaType === source.type
                )
            )
                return yield* invalid(
                    `Attachment media type "${source.type || "(empty)"}" is not allowed by the target.`
                );
            const id = settings?.id ?? crypto.randomUUID();
            yield* manager.stage(id, source);
            if (constraint?.size && source.size === undefined) {
                const metadata = yield* manager.metadata(id);
                if (metadata.size === undefined || !inRange(metadata.size, constraint.size))
                    return yield* invalid("Attachment size is outside the allowed range.");
            }
            const value: attachment = { id, type: source.type };
            if (!settings?.eager || !options.stage) return { attachment: value };
            const fiber = yield* Effect.forkIn(
                Effect.gen(function* () {
                    const bytes = yield* manager.source(id);
                    const materialized = yield* options.stage!(value, bytes, {
                        target: type?.kind === "attachment" ? type.value : undefined,
                    });
                    if (materialized.id !== id) yield* manager.bindRemoteId(id, materialized.id);
                    Object.assign(value, materialized);
                }).pipe(Effect.scoped),
                owner
            );
            return { attachment: value, isMaterialized: Fiber.join(fiber) };
        }),
        source: (value, settings) =>
            Effect.flatMap(requireManager(), (manager) =>
                manager.source(value.id, { signal: settings?.signal, meta: { attachment: value } })
            ),
        blob: (value) =>
            Effect.flatMap(requireManager(), (manager) =>
                manager.read(value.id, { meta: { attachment: value } })
            ),
        metadata: Effect.fn("Replica.attachments.metadata")(function* (value, settings) {
            const manager = yield* requireManager();
            const select = settings?.select ?? ["size", "type", "name"];
            const resolved = yield* manager.metadata(value.id, { meta: { attachment: value }, select });
            if (select.includes("dimensions") && resolved.dimensions === null)
                return yield* new BackendError({
                    operation: "attachment.metadata",
                    kind: "NotImplemented",
                    message: `Dimensions are unavailable for attachment "${value.id}".`,
                    retryable: false,
                });
            const { name, ...metadata } = resolved;
            return { ...value, ...metadata, ...(typeof name === "string" ? { name } : {}) };
        }),
    };
});
