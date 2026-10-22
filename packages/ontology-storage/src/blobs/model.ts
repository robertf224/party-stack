import { Context, Effect, Schema } from "effect";

export class BlobStorageError extends Schema.TaggedError<BlobStorageError>()("BlobStorageError", {
    kind: Schema.Literals(["NotFound", "Busy", "Conflict", "Bytes", "InvalidValue"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
}) {}

/** External byte stores need idempotent deletion and immutable keys supplied by storage. */
export interface BlobBytesService {
    readonly read: (key: string) => Effect.Effect<Blob | undefined, unknown>;
    readonly write: (key: string, value: Blob) => Effect.Effect<void, unknown>;
    readonly delete: (key: string) => Effect.Effect<void, unknown>;
}
export class BlobBytes extends Context.Service<BlobBytes, BlobBytesService>()(
    "@party-stack/ontology-storage/blobs/BlobBytes"
) {}

export const BlobMetadataSchema = Schema.Struct({
    size: Schema.optional(Schema.Number),
    type: Schema.optional(Schema.String),
    name: Schema.optional(Schema.NullOr(Schema.String)),
    dimensions: Schema.optional(
        Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number }))
    ),
});
export type BlobMetadata = typeof BlobMetadataSchema.Type;
export const BlobRecordSchema = Schema.Struct({
    ...BlobMetadataSchema.fields,
    id: Schema.String,
    remoteId: Schema.optional(Schema.String),
    state: Schema.Literals(["staged", "cached", "persisted"]),
    byteKey: Schema.optional(Schema.String),
    writing: Schema.optional(Schema.String),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    lastAccessedAt: Schema.Number,
    /** Derived from reverse references; never an independently incremented count. */
    unreferencedAt: Schema.optional(Schema.Number),
    bytesRetained: Schema.optional(Schema.Boolean),
});
export type BlobRecord = typeof BlobRecordSchema.Type;

export const blobFailure = (kind: BlobStorageError["kind"], message: string, cause?: unknown) =>
    new BlobStorageError({ kind, message, cause });
