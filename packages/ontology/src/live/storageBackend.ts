import { BackendError, encryptedPropertyCodec, EncryptedValueSchema } from "@party-stack/ontology-backend";
import { makeOwnedBackend, type OwnedBackendService } from "@party-stack/ontology-backend/owned";
import { CurrentExecutionContext } from "@party-stack/ontology-backend/policy";
import {
    digestBytes as digest,
    byteSource,
    sliceByteSource,
    type ByteInput,
} from "@party-stack/ontology-storage/blobs";
import { makeEncryptedValues, type EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema, Stream } from "effect";
import { executeTransactionMutator, withTransactionCollections } from "../runtime/index.js";
import { resolveReadActionParameters } from "../runtime/resolveActionParameters.js";
import { createReadTx } from "./mutators/createMutatorTx.js";
import type { OntologyMutatorRegistry, OntologyQueryFunctionRegistry } from "./mutators/types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { BlobStorageService } from "@party-stack/ontology-storage/blobs";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export interface StorageOntologyBackendOptions {
    readonly ir: OntologyIR;
    readonly namespace: string;
    readonly clients?: import("@party-stack/ontology-backend/clients").ClientPolicy;
    readonly history?: import("@party-stack/ontology-backend/owned").OwnedBackendOptions["history"];
    readonly resultRetentionMs?: number;
    readonly actionScope?: string;
    readonly tables: TablesService;
    readonly blobs: BlobStorageService;
    /** Authority-owned keys, supplied by the deployment (KMS, secrets, or a platform key store). */
    readonly encryptionKeyring?: EncryptionKeyringService;
    readonly context?: Record<string, unknown>;
    readonly mutators?: OntologyMutatorRegistry;
    readonly queryFunctions?: OntologyQueryFunctionRegistry;
}
const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "storage-ontology",
              kind: "Unavailable",
              message: "Ontology storage failed.",
              retryable: false,
              cause,
          });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(failure));
const promise = <A>(body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: failure });

/** Shared authoritative execution/attachment composition; platform factories supply Tables and byte IO. */
export const makeStorageOntologyBackend = Effect.fn("StorageOntology.make")(function* (
    options: StorageOntologyBackendOptions
) {
    const { tables, blobs } = options;
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
        clients: options.clients,
        history: options.history,
        resultRetentionMs: options.resultRetentionMs,
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
        actionScope: options.actionScope ?? JSON.stringify(options.context?.user ?? "system"),
        mutators: Object.fromEntries(
            options.ir.actionTypes
                .filter((action) => action.logic.length || options.mutators?.[action.name])
                .map((action) => [
                    action.name,
                    (tx, invocation) =>
                        Effect.flatMap(CurrentExecutionContext, (context) =>
                            executeTransactionMutator({
                                ir: options.ir,
                                tx,
                                name: invocation.name,
                                parameters: invocation.parameters,
                                operationId: invocation.id,
                                replay: invocation.replay,
                                context: context ?? options.context,
                                mutators: options.mutators,
                            })
                        ).pipe(Effect.asVoid),
                ])
        ),
        queryFunctions: Object.fromEntries(
            Object.entries(options.queryFunctions ?? {}).map(([name, handler]) => [
                name,
                (tx, parameters) =>
                    Effect.flatMap(CurrentExecutionContext, (context) =>
                        withTransactionCollections(options.ir, tx, (objects, ensureLoaded) =>
                            promise(async () =>
                                handler({
                                    tx: createReadTx(objects, ensureLoaded),
                                    args: parameters,
                                    context: context ?? options.context ?? {},
                                })
                            )
                        )
                    ),
            ])
        ),
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

    return {
        ...backend,
        // Incoming HTTP sources may be one-shot. Owned storage accepts bytes into
        // its final byte store first; fingerprinting and retries reopen that store.
        applyAction: Effect.fn("StorageOntology.applyAction")(function* (
            invocation: import("@party-stack/ontology-backend").ActionRequest
        ) {
            const uploads: import("@party-stack/ontology-backend").AttachmentUpload[] = [];
            for (const upload of invocation.attachmentUploads ?? []) {
                yield* stage(upload.attachment, upload.blob);
                uploads.push({ ...upload, blob: yield* backend.attachments!.read(upload.attachment) });
            }
            return yield* backend.applyAction({ ...invocation, attachmentUploads: uploads });
        }),
        blobs,
        resolveActionParameters: (name: string, parameters: Record<string, unknown>) =>
            backend.storage.read((read) =>
                resolveReadActionParameters({
                    ir: options.ir,
                    read,
                    name,
                    parameters,
                    context: options.context,
                })
            ),
        collectGarbage: (options?: { readonly orphanGraceMs?: number; readonly limit?: number }) =>
            boundary(
                (backend.maintenance ?? Effect.void).pipe(
                    Effect.andThen(blobs.collectGarbage({ olderThanMs: 0, ...options }))
                )
            ),
    };
});
