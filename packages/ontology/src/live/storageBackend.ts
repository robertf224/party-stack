import { BackendError, encryptedPropertyCodec, EncryptedValueSchema } from "@party-stack/ontology-backend";
import { makeOwnedBackend, type OwnedBackendService } from "@party-stack/ontology-backend/owned";
import { makeEncryptedValues, type EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";
import { executeTransactionMutator, withTransactionCollections } from "../runtime/index.js";
import { createReadTx } from "./mutators/createMutatorTx.js";
import type { OntologyMutatorRegistry, OntologyQueryFunctionRegistry } from "./mutators/types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { BlobStorageService } from "@party-stack/ontology-storage/blobs";
import type { TablesService } from "@party-stack/ontology-storage/tables";

export interface StorageOntologyBackendOptions {
    readonly ir: OntologyIR;
    readonly namespace: string;
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
const digest = (blob: Blob) =>
    promise(async () => {
        const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    });

/** Shared authoritative execution/attachment composition; platform factories supply Tables and byte IO. */
export const makeStorageOntologyBackend = Effect.fn("StorageOntology.make")(function* (
    options: StorageOntologyBackendOptions
) {
    const { tables, blobs } = options;
    yield* boundary(blobs.recover);
    const stage = Effect.fn("StorageOntology.stageAttachment")(function* (
        attachment: attachment,
        blob: Blob
    ) {
        const stored = yield* boundary(blobs.metadata(attachment.id));
        if (stored?.byteKey) {
            const existing = yield* boundary(blobs.read(attachment.id));
            if (!existing || (yield* digest(existing)) !== (yield* digest(blob)))
                return yield* new BackendError({
                    operation: "attachment.stage",
                    kind: "Conflict",
                    message: "An attachment ID was reused for different bytes.",
                    retryable: false,
                });
        } else yield* boundary(blobs.stage(attachment.id, blob));
        return { ...attachment, type: blob.type };
    });
    const backend: OwnedBackendService = yield* makeOwnedBackend({
        namespace: options.namespace,
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
                                  kind: "Rejected",
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
                          !("id" in current) ||
                          current.id !== value.id
                      )
                          return yield* new BackendError({
                              operation: "decrypt",
                              kind: "Conflict",
                              message: "The encrypted property changed or is unavailable.",
                              retryable: false,
                          });
                      const plaintext = yield* makeEncryptedValues(
                          options.namespace,
                          tables,
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
                              return { value: plaintext, valueId: value.id };
                          },
                          catch: () =>
                              new BackendError({
                                  operation: "decrypt",
                                  kind: "Rejected",
                                  message: "Invalid decrypted plaintext.",
                                  retryable: false,
                              }),
                      });
                  }),
              }
            : undefined,
        invocationScope: JSON.stringify(options.context?.user ?? "system"),
        mutators: Object.fromEntries(
            options.ir.actionTypes
                .filter((action) => action.logic.length || options.mutators?.[action.name])
                .map((action) => [
                    action.name,
                    (tx, invocation) =>
                        executeTransactionMutator({
                            ir: options.ir,
                            tx,
                            name: invocation.name,
                            parameters: invocation.parameters,
                            invocationId: invocation.id,
                            replay: invocation.replay,
                            context: options.context,
                            mutators: options.mutators,
                        }).pipe(Effect.asVoid),
                ])
        ),
        queryFunctions: Object.fromEntries(
            Object.entries(options.queryFunctions ?? {}).map(([name, handler]) => [
                name,
                (tx, parameters) =>
                    withTransactionCollections(options.ir, tx, (objects, ensureLoaded) =>
                        promise(async () =>
                            handler({
                                tx: createReadTx(objects, ensureLoaded),
                                args: parameters,
                                context: options.context ?? {},
                            })
                        )
                    ),
            ])
        ),
        prepareUploads: Effect.fn("StorageOntology.prepareUploads")(function* (invocation) {
            for (const upload of invocation.attachmentUploads ?? [])
                yield* stage(upload.attachment, upload.blob);
            return boundary(
                Effect.forEach(
                    invocation.attachmentUploads ?? [],
                    (upload) => blobs.in(tables).bindRemoteId(upload.attachment.id, upload.attachment.id),
                    { discard: true }
                )
            );
        }),
        attachments: {
            stage,
            read: (attachment, range) =>
                boundary(
                    Effect.gen(function* () {
                        const content = yield* blobs.read(attachment.id);
                        if (!content)
                            return yield* new BackendError({
                                operation: "attachment.read",
                                kind: "NotFound",
                                message: "Attachment not found.",
                                retryable: false,
                            });
                        if (!range) return content;
                        if (
                            !Number.isSafeInteger(range.offset ?? 0) ||
                            (range.offset ?? 0) < 0 ||
                            (range.length !== undefined &&
                                (!Number.isSafeInteger(range.length) || range.length < 0))
                        )
                            return yield* new BackendError({
                                operation: "attachment.read",
                                kind: "Rejected",
                                message: "Invalid attachment range.",
                                retryable: false,
                            });
                        return content.slice(
                            range.offset ?? 0,
                            range.length === undefined ? undefined : (range.offset ?? 0) + range.length,
                            content.type
                        );
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
        blobs,
        collectGarbage: (options?: { readonly orphanGraceMs?: number; readonly limit?: number }) =>
            boundary(blobs.collectGarbage({ olderThanMs: 0, ...options })),
    };
});
