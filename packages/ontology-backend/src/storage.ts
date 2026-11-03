import { contextPartition } from "@party-stack/ontology-spec/utils";
import { digestBytes as digest, byteSource, sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Effect, Redacted, Schema, Stream } from "effect";
import { executeAction, resolveReadActionParameters } from "./actions.js";
import { maintenanceInterval, scheduleMaintenance } from "./maintenance.js";
import { makeOwnedBackend } from "./owned.js";
import { CurrentExecutionContext } from "./policy.js";
import {
    BackendError,
    classifyBackendFailure,
    encryptedPropertyCodec,
    EncryptedValueSchema,
} from "./index.js";
import type { ActionRequest, AttachmentUpload } from "./index.js";
import type { OwnedBackendOptions, OwnedBackendService, OwnedTransaction } from "./owned.js";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { BlobStorageService, ByteInput } from "@party-stack/ontology-storage/blobs";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";

export interface StorageBackendOptions extends Omit<
    OwnedBackendOptions,
    "attachments" | "encrypted" | "prepareUploads" | "blobs" | "mutators"
> {
    readonly blobs: BlobStorageService;
    readonly encryptionKeyring?: EncryptionKeyringService;
    readonly context?: Record<string, unknown>;
    readonly mutators?: OwnedBackendOptions["mutators"];
}
const failure = (cause: unknown) => classifyBackendFailure("storage-ontology", cause);
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(failure));

/** Shared authoritative execution/attachment composition; platform factories supply Tables and byte IO. */
export const makeStorageBackend = Effect.fn("StorageOntology.make")(function* (
    options: StorageBackendOptions
) {
    const { tables, blobs } = options;
    const maintenanceIntervalMs = yield* maintenanceInterval(options.maintenance);
    const actionScope = yield* Effect.try({
        try: () =>
            options.actionScope ??
            (options.context ? contextPartition(options.ir, options.context) : "system"),
        catch: (cause) =>
            new BackendError({
                operation: "storage-ontology",
                kind: "InvalidConfiguration",
                message: "Invalid action identity partition.",
                retryable: false,
                cause: Redacted.make(cause),
            }),
    });
    yield* boundary(blobs.recover);
    const stage = Effect.fn("StorageOntology.stageAttachment")(function* (
        attachment: attachment,
        blob: ByteInput
    ) {
        const stored = yield* boundary(blobs.metadata(attachment.id));
        if (stored?.byteKey) {
            const existing = yield* boundary(
                Effect.scoped(
                    blobs
                        .readScoped(attachment.id)
                        .pipe(
                            Effect.flatMap((source) => (source ? digest(source) : Effect.succeed(undefined)))
                        )
                )
            );
            if (!existing || existing !== (yield* boundary(digest(blob))))
                return yield* new BackendError({
                    operation: "attachment.stage",
                    kind: "Conflict",
                    message: "An attachment ID was reused for different bytes.",
                    retryable: false,
                });
        } else yield* boundary(blobs.stage(attachment.id, blob));
        return { ...attachment, type: byteSource(blob).type };
    });
    const backend: OwnedBackendService = yield* makeOwnedBackend({
        namespace: options.namespace,
        delivery: options.delivery,
        history: options.history,
        resultRetentionMs: options.resultRetentionMs,
        // This owner schedules the composed row/receipt/delivery/blob pass below.
        maintenance: false,
        ir: options.ir,
        tables,
        blobs,
        encrypted: options.encryptionKeyring
            ? {
                  decrypt: Effect.fn("StorageOntology.decrypt")(function* (value) {
                      const checked = yield* Effect.try({
                          try: () => {
                              const handle = Schema.decodeUnknownSync(EncryptedValueSchema)(value);
                              return { handle, codec: encryptedPropertyCodec(options.ir, handle) };
                          },
                          catch: () =>
                              new BackendError({
                                  operation: "decrypt",
                                  kind: "InvalidRequest",
                                  message: "Invalid encrypted property handle.",
                                  retryable: false,
                              }),
                      });
                      const source = checked.handle.source!;
                      const row = yield* backend.storage.read((tx) =>
                          tx.get(source.objectType, source.primaryKey)
                      );
                      const current = row?.[source.property];
                      if (
                          !current ||
                          typeof current !== "object" ||
                          !("ciphertext" in current) ||
                          current.ciphertext !== value.ciphertext
                      )
                          return yield* new BackendError({
                              operation: "decrypt",
                              kind: "Conflict",
                              message: "The encrypted property changed or is unavailable.",
                              retryable: false,
                          });
                      const plaintext = yield* makeEncryptedValues(
                          options.namespace,
                          options.encryptionKeyring!
                      )
                          .decrypt(Schema.Unknown, checked.handle)
                          .pipe(
                              Effect.mapError(
                                  () =>
                                      new BackendError({
                                          operation: "decrypt",
                                          kind: "Unavailable",
                                          message: "Encrypted value is unavailable.",
                                          retryable: false,
                                      })
                              )
                          );
                      return yield* Effect.try({
                          try: () => {
                              checked.codec.decode(plaintext);
                              return { value: plaintext, ciphertext: value.ciphertext };
                          },
                          catch: () =>
                              new BackendError({
                                  operation: "decrypt",
                                  kind: "Internal",
                                  message: "Invalid decrypted plaintext.",
                                  retryable: false,
                              }),
                      });
                  }),
              }
            : undefined,
        actionScope,
        mutators: {
            ...Object.fromEntries(
                options.ir.actionTypes
                    .filter((action) => action.logic.length)
                    .map((action) => [
                        action.name,
                        (tx: OwnedTransaction, invocation: ActionRequest) =>
                            Effect.flatMap(CurrentExecutionContext, (context) =>
                                executeAction({
                                    ir: options.ir,
                                    tx,
                                    request: invocation,
                                    context: context ?? options.context,
                                })
                            ),
                    ])
            ),
            ...options.mutators,
        },
        queryFunctions: options.queryFunctions,
        prepareUploads: Effect.fn("StorageOntology.prepareUploads")((invocation) =>
            Effect.succeed(
                boundary(
                    Effect.forEach(
                        invocation.attachmentUploads ?? [],
                        (upload) => blobs.in(tables).bindRemoteId(upload.attachment.id, upload.attachment.id),
                        { discard: true }
                    )
                )
            )
        ),
        attachments: {
            stage,
            read: (attachment, range) =>
                boundary(
                    Effect.gen(function* () {
                        const metadata = yield* blobs.metadata(attachment.id);
                        if (!metadata?.byteKey)
                            return yield* new BackendError({
                                operation: "attachment.read",
                                kind: "NotFound",
                                message: "Attachment not found.",
                                retryable: false,
                            });
                        const offset = range?.offset ?? 0;
                        const length = range?.length;
                        if (
                            !Number.isSafeInteger(offset) ||
                            offset < 0 ||
                            (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
                        )
                            return yield* new BackendError({
                                operation: "attachment.read",
                                kind: "InvalidRequest",
                                message: "Invalid attachment range.",
                                retryable: false,
                            });
                        return {
                            type: metadata.type ?? "application/octet-stream",
                            name: metadata.name ?? undefined,
                            size:
                                metadata.size === undefined
                                    ? undefined
                                    : Math.min(Math.max(0, metadata.size - offset), length ?? Infinity),
                            stream: Stream.unwrap(
                                Effect.gen(function* () {
                                    const content = yield* blobs.readScoped(attachment.id);
                                    if (!content)
                                        return yield* new BackendError({
                                            operation: "attachment.read",
                                            kind: "NotFound",
                                            message: "Attachment bytes are unavailable.",
                                            retryable: false,
                                        });
                                    return sliceByteSource(content, offset, length).stream;
                                })
                            ),
                        };
                    })
                ),
            metadata: (attachment) =>
                boundary(
                    Effect.gen(function* () {
                        const record = yield* blobs.metadata(attachment.id);
                        if (!record || record.size === undefined || record.type === undefined)
                            return yield* new BackendError({
                                operation: "attachment.metadata",
                                kind: "NotFound",
                                message: "Attachment not found.",
                                retryable: false,
                            });
                        return { size: record.size, type: record.type, name: record.name ?? attachment.id };
                    })
                ),
        },
    });

    const collectGarbage = (options?: { readonly orphanGraceMs?: number; readonly limit?: number }) =>
        boundary(
            (backend.maintenance ?? Effect.void).pipe(
                Effect.andThen(blobs.collectGarbage({ olderThanMs: 0, ...options }))
            )
        );
    const maintenance = collectGarbage().pipe(Effect.asVoid);
    yield* scheduleMaintenance(maintenance, maintenanceIntervalMs);
    return {
        ...backend,
        maintenance,
        // Incoming HTTP sources may be one-shot. Owned storage accepts bytes into
        // its final byte store first; fingerprinting and retries reopen that store.
        applyAction: Effect.fn("StorageOntology.applyAction")(function* (invocation: ActionRequest) {
            const uploads: AttachmentUpload[] = [];
            for (const upload of invocation.attachmentUploads ?? []) {
                yield* stage(upload.attachment, upload.blob);
                uploads.push({ ...upload, blob: yield* backend.attachments!.read(upload.attachment) });
            }
            return yield* backend.applyAction({ ...invocation, attachmentUploads: uploads });
        }),
        blobs,
        resolveActionParameters: Effect.fn("StorageOntology.resolveParameters")(function* (
            name: string,
            parameters: Record<string, unknown>
        ) {
            const context = (yield* CurrentExecutionContext) ?? options.context;
            return yield* backend.storage.read((read) =>
                resolveReadActionParameters({
                    ir: options.ir,
                    read,
                    name,
                    parameters,
                    context,
                })
            );
        }),
        collectGarbage,
    };
});
