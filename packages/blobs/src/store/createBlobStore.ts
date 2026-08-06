import { invariant } from "@bobbyfidz/panic";
import {
    CoordinationTaskRejectedError,
    createLocalCollection,
    isCoordinationHost,
    type CoordinationCallOptions,
    type CoordinationServiceHandlers,
    type CoordinationServiceServer,
    type RuntimeAdapter,
} from "@party-stack/runtime";
import { eq, or, queryOnce, type Collection } from "@tanstack/db";
import type {
    BlobMetadataRecord,
    BlobOperation,
    BlobRef,
    PartialBlobMetadata,
} from "../types.js";

type BlobWriteRecord = BlobMetadataRecord &
    Required<Pick<PartialBlobMetadata, "size" | "type">>;

export const BLOB_COORDINATION_SERVICE = "party-stack.blobs.v1";

export type BlobCoordinationRejectionCode =
    | "BLOB_NOT_FOUND"
    | "BLOB_OPERATION_CONFLICT"
    | "BLOB_OPERATION_STALE"
    | "BLOB_RECOVERY_NOT_LEADER";

export type BlobWriteKind = "stage" | "cache";

export interface BlobWriteMetadata {
    type: string;
    size: number;
    name?: string;
}

export interface BeginBlobWriteInput {
    id: string;
    kind: BlobWriteKind;
    metadata: BlobWriteMetadata;
}

export interface BeginBlobWriteResult {
    id: string;
    operationId: string;
}

export interface BlobOperationInput {
    id: string;
    operationId: string;
}

export interface FailBlobWriteInput extends BlobOperationInput {
    error: string;
}

export interface UpsertBlobMetadataInput {
    id: string;
    metadata: PartialBlobMetadata;
    remote: boolean;
}

export type BlobCoordinationService = {
    methods: {
        beginWrite(input: BeginBlobWriteInput): Promise<BeginBlobWriteResult>;
        commitWrite(input: BlobOperationInput): Promise<BlobRef>;
        failWrite(input: FailBlobWriteInput): Promise<BlobRef>;
        find(input: { id: string }): Promise<BlobMetadataRecord | undefined>;
        upsertMetadata(input: UpsertBlobMetadataInput): Promise<BlobMetadataRecord>;
        touch(input: { id: string }): Promise<BlobMetadataRecord>;
        bindRemoteId(input: {
            localId: string;
            remoteId: string;
        }): Promise<BlobRef>;
        purge(input: { id: string }): Promise<void>;
        recover(input: { recoveryId: string }): Promise<void>;
    };
    events: Record<never, never>;
};

export class BlobBytesUnavailableError extends Error {
    constructor(
        readonly id: string,
        options?: ErrorOptions
    ) {
        super(`Blob bytes are unavailable for "${id}".`, options);
        this.name = "BlobBytesUnavailableError";
    }
}

export interface BlobStore {
    readonly collection: Collection<BlobMetadataRecord, string>;
    readonly ready: Promise<void>;
    beginWrite(input: BeginBlobWriteInput): Promise<BeginBlobWriteResult>;
    commitWrite(input: BlobOperationInput): Promise<BlobRef>;
    failWrite(input: FailBlobWriteInput): Promise<BlobRef>;
    stage(id: string, blob: Blob | File): Promise<BlobRef>;
    cache(id: string, blob: Blob | File): Promise<BlobRef>;
    find(id: string): Promise<BlobMetadataRecord | undefined>;
    upsertMetadata(
        id: string,
        metadata: PartialBlobMetadata,
        remote: boolean
    ): Promise<BlobMetadataRecord>;
    read(id: string): Promise<Blob>;
    bindRemoteId(
        localId: string,
        remoteId: string
    ): Promise<BlobRef>;
    purge(id: string, options?: CoordinationCallOptions): Promise<void>;
    recoverAsLeader(signal: AbortSignal): Promise<void>;
    clearActiveOperations(): void;
    cleanup(): Promise<void>;
}

export interface CreateBlobStoreOptions {
    runtime: RuntimeAdapter;
    onCacheChanged?: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function interruptedOperationError(kind: BlobOperation["kind"], cleanupError?: unknown): string {
    const message = `Blob ${kind} operation was interrupted before completion.`;
    return cleanupError === undefined
        ? `${message} Potentially partial bytes were deleted.`
        : `${message} Failed to delete potentially partial bytes: ${errorMessage(cleanupError)}`;
}

function blobName(blob: Blob): string | undefined {
    return "name" in blob && typeof blob.name === "string" ? blob.name : undefined;
}

function randomOperationId(): string {
    return (
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
}

function rejectTask(code: BlobCoordinationRejectionCode, message: string): never {
    throw new CoordinationTaskRejectedError(message, code);
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Blob operation was aborted.");
    }
}

export function createBlobStore(options: CreateBlobStoreOptions): BlobStore {
    const collection = createLocalCollection<BlobMetadataRecord, string>({
        name: "blob-metadata",
        getKey: (ref) => ref.id,
        runtime: options.runtime,
        schemaVersion: 2,
    });
    const ready = collection.preload();
    const bytes = options.runtime.blobBytes;
    const activeOperationIds = new Set<string>();
    const client = options.runtime.coordination.service<BlobCoordinationService>(BLOB_COORDINATION_SERVICE);
    let activeRecoveryId: string | undefined;

    const findRef = async (id: string): Promise<BlobMetadataRecord | undefined> => {
        await ready;
        const result = await queryOnce((query) =>
            query
                .from({ blob: collection })
                .where(({ blob }) => or(eq(blob.id, id), eq(blob.remoteId, id)))
                .select(({ blob }) => ({
                    id: blob.id,
                    remoteId: blob.remoteId,
                    type: blob.type,
                    size: blob.size,
                    name: blob.name,
                    dimensions: blob.dimensions,
                    state: blob.state,
                    operation: blob.operation,
                    lastAccessedAt: blob.lastAccessedAt,
                    createdAt: blob.createdAt,
                    updatedAt: blob.updatedAt,
                }))
                .findOne()
        );
        return result as BlobMetadataRecord | undefined;
    };

    const putRef = async (ref: BlobMetadataRecord): Promise<void> => {
        const transaction = collection.has(ref.id)
            ? collection.update(ref.id, { optimistic: false }, (draft) => {
                  Object.assign(draft, ref);
                  draft.remoteId = ref.remoteId;
                  draft.name = ref.name;
                  draft.state = ref.state;
                  draft.operation = ref.operation;
                  draft.lastAccessedAt = ref.lastAccessedAt;
              })
            : collection.insert(ref, { optimistic: false });
        await transaction.isPersisted.promise;
    };

    const patchRef = async (
        id: string,
        patch: (draft: BlobMetadataRecord, timestamp: number) => void
    ): Promise<BlobMetadataRecord> => {
        const ref = await findRef(id);
        if (!ref) {
            return rejectTask("BLOB_NOT_FOUND", `Blob metadata not found for "${id}".`);
        }
        const transaction = collection.update(ref.id, { optimistic: false }, (draft) => {
            patch(draft, Date.now());
        });
        await transaction.isPersisted.promise;
        const updated = await findRef(ref.id);
        invariant(updated, `Blob metadata disappeared for "${ref.id}".`);
        return updated;
    };

    const deleteRef = async (id: string): Promise<void> => {
        if (!collection.has(id)) return;
        await collection.delete(id, {
            optimistic: false,
        }).isPersisted.promise;
    };

    const applyMetadata = (
        draft: BlobMetadataRecord,
        metadata: PartialBlobMetadata
    ): void => {
        if (metadata.size !== undefined) draft.size = metadata.size;
        if (metadata.type !== undefined) draft.type = metadata.type;
        if (Object.hasOwn(metadata, "name")) {
            draft.name = metadata.name ?? null;
        }
        if (Object.hasOwn(metadata, "dimensions")) {
            draft.dimensions = metadata.dimensions ?? null;
        }
    };

    const requireBlobRef = (record: BlobMetadataRecord): BlobRef => {
        invariant(
            record.size !== undefined && record.type !== undefined,
            `Blob "${record.id}" is missing size or type metadata.`
        );
        return {
            id: record.id,
            size: record.size,
            type: record.type,
            ...(typeof record.name === "string" ? { name: record.name } : {}),
        };
    };

    const currentOperation = async (
        input: BlobOperationInput
    ): Promise<{
        ref: BlobWriteRecord;
        operation: Extract<BlobOperation, { status: "pending" }>;
    }> => {
        const ref = await findRef(input.id);
        const operation = ref?.operation;
        if (
            !ref ||
            ref.size === undefined ||
            ref.type === undefined ||
            operation?.status !== "pending" ||
            operation.operationId !== input.operationId
        ) {
            return rejectTask(
                "BLOB_OPERATION_STALE",
                `Blob operation "${input.operationId}" is no longer current for "${input.id}".`
            );
        }
        return { ref: ref as BlobWriteRecord, operation };
    };

    const host = isCoordinationHost(options.runtime.coordination) ? options.runtime.coordination : undefined;
    const handlers: CoordinationServiceHandlers<BlobCoordinationService> | undefined = host
        ? {
              async beginWrite(input) {
                  await ready;
                  const existing = await findRef(input.id);
                  if (existing?.operation?.status === "pending") {
                      return rejectTask(
                          "BLOB_OPERATION_CONFLICT",
                          `Blob "${existing.id}" already has an active ${existing.operation.kind} operation.`
                      );
                  }

                  const operationId = randomOperationId();
                  const timestamp = Date.now();
                  const ref: BlobWriteRecord = {
                      id: existing?.id ?? input.id,
                      remoteId:
                          input.kind === "cache"
                              ? (existing?.remoteId ?? (existing ? undefined : input.id))
                              : existing?.remoteId,
                      type: input.metadata.type,
                      size: input.metadata.size,
                      name:
                          input.metadata.name ??
                          (typeof existing?.name === "string" ? existing.name : null),
                      state: input.kind === "cache" ? (existing?.state ?? "persisted") : existing?.state,
                      operation: {
                          kind: input.kind,
                          status: "pending",
                          operationId,
                      },
                      lastAccessedAt: existing?.lastAccessedAt,
                      createdAt: existing?.createdAt ?? timestamp,
                      updatedAt: timestamp,
                  };
                  activeOperationIds.add(operationId);
                  try {
                      await putRef(ref);
                  } catch (error) {
                      activeOperationIds.delete(operationId);
                      throw error;
                  }
                  return {
                      id: ref.id,
                      operationId,
                  };
              },

              async commitWrite(input) {
                  const { ref, operation } = await currentOperation(input);
                  if (operation.kind !== "stage" && operation.kind !== "cache") {
                      return rejectTask(
                          "BLOB_OPERATION_STALE",
                          `Blob operation "${input.operationId}" is not a write operation.`
                      );
                  }
                  try {
                      const committed = await patchRef(ref.id, (draft, updatedAt) => {
                          if (operation.kind === "stage") {
                              draft.state = "staged";
                          } else {
                              draft.state = "cached";
                              draft.lastAccessedAt = updatedAt;
                          }
                          draft.updatedAt = updatedAt;
                          draft.operation = undefined;
                      });
                      if (operation.kind === "cache") {
                          options.onCacheChanged?.();
                      }
                      return requireBlobRef(committed);
                  } finally {
                      activeOperationIds.delete(input.operationId);
                  }
              },

              async failWrite(input) {
                  const ref = await findRef(input.id);
                  const operation = ref?.operation;
                  if (
                      !ref ||
                      !operation ||
                      operation.operationId !== input.operationId ||
                      (operation.kind !== "stage" && operation.kind !== "cache")
                  ) {
                      return rejectTask(
                          "BLOB_OPERATION_STALE",
                          `Blob operation "${input.operationId}" is not a write operation.`
                      );
                  }
                  let failure = input.error;
                  try {
                      await bytes.delete(ref.id);
                  } catch (cleanupError) {
                      failure += `; cleanup failed: ${errorMessage(cleanupError)}`;
                  }
                  try {
                      return requireBlobRef(await patchRef(ref.id, (draft, updatedAt) => {
                          draft.updatedAt = updatedAt;
                          draft.operation = {
                              kind: operation.kind,
                              status: "failed",
                              operationId: input.operationId,
                              error: failure,
                          };
                      }));
                  } finally {
                      activeOperationIds.delete(input.operationId);
                  }
              },

              find(input) {
                  return findRef(input.id);
              },

              async upsertMetadata(input) {
                  const existing = await findRef(input.id);
                  if (existing) {
                      return patchRef(existing.id, (draft, updatedAt) => {
                          applyMetadata(draft, input.metadata);
                          draft.updatedAt = updatedAt;
                      });
                  }
                  const timestamp = Date.now();
                  const record: BlobMetadataRecord = {
                      id: input.id,
                      remoteId: input.remote ? input.id : undefined,
                      state: input.remote ? "persisted" : undefined,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                  };
                  applyMetadata(record, input.metadata);
                  await putRef(record);
                  return record;
              },

              touch(input) {
                  return patchRef(input.id, (draft, timestamp) => {
                      draft.lastAccessedAt = timestamp;
                      draft.updatedAt = timestamp;
                  });
              },

              async bindRemoteId(input) {
                  const ref = await findRef(input.localId);
                  if (!ref) {
                      return rejectTask("BLOB_NOT_FOUND", `Blob metadata not found for "${input.localId}".`);
                  }
                  if (ref.operation?.status === "pending") {
                      return rejectTask(
                          "BLOB_OPERATION_CONFLICT",
                          `Blob "${ref.id}" has an active ${ref.operation.kind} operation.`
                      );
                  }
                  return requireBlobRef(await patchRef(ref.id, (draft, updatedAt) => {
                      draft.remoteId = input.remoteId;
                      draft.state = "persisted";
                      draft.updatedAt = updatedAt;
                      draft.operation = undefined;
                  }));
              },

              async purge(input) {
                  const ref = await findRef(input.id);
                  if (!ref) {
                      await bytes.delete(input.id);
                      return;
                  }
                  if (ref.operation?.status === "pending") {
                      return rejectTask(
                          "BLOB_OPERATION_CONFLICT",
                          `Blob "${ref.id}" has an active ${ref.operation.kind} operation.`
                      );
                  }

                  const operationId = randomOperationId();
                  activeOperationIds.add(operationId);
                  try {
                      await patchRef(ref.id, (draft, updatedAt) => {
                          draft.operation = {
                              kind: "purge",
                              status: "pending",
                              operationId,
                          };
                          draft.updatedAt = updatedAt;
                      });
                      await bytes.delete(ref.id);
                      await deleteRef(ref.id);
                  } catch (error) {
                      await patchRef(ref.id, (draft, updatedAt) => {
                          draft.operation = {
                              kind: "purge",
                              status: "failed",
                              operationId,
                              error: errorMessage(error),
                          };
                          draft.updatedAt = updatedAt;
                      });
                      throw error;
                  } finally {
                      activeOperationIds.delete(operationId);
                  }
              },

              async recover(input, context) {
                  if (input.recoveryId !== activeRecoveryId || !host.isLeader) {
                      return rejectTask(
                          "BLOB_RECOVERY_NOT_LEADER",
                          "Blob recovery may only run inside the active leadership term."
                      );
                  }
                  await ready;
                  const refs = (await queryOnce((query) =>
                      query
                          .from({ blob: collection })
                          .where(({ blob }) => eq(blob.operation!.status, "pending"))
                          .select(({ blob }) => ({
                              id: blob.id,
                              operation: blob.operation,
                          }))
                  )) as Array<Pick<BlobMetadataRecord, "id" | "operation">>;

                  for (const pending of refs) {
                      throwIfAborted(context.signal);
                      const current = await findRef(pending.id);
                      const operation = current?.operation;
                      if (
                          !current ||
                          operation?.status !== "pending" ||
                          activeOperationIds.has(operation.operationId)
                      ) {
                          continue;
                      }

                      const operationId = operation.operationId ?? randomOperationId();
                      if (operation.kind === "stage" || operation.kind === "cache") {
                          let cleanupError: unknown;
                          try {
                              await bytes.delete(current.id);
                          } catch (error) {
                              cleanupError = error;
                          }
                          await patchRef(current.id, (draft, updatedAt) => {
                              draft.operation = {
                                  kind: operation.kind,
                                  status: "failed",
                                  operationId,
                                  error: interruptedOperationError(operation.kind, cleanupError),
                              };
                              draft.updatedAt = updatedAt;
                          });
                          continue;
                      }

                      try {
                          await bytes.delete(current.id);
                          await deleteRef(current.id);
                      } catch (error) {
                          const remaining = await findRef(current.id);
                          if (
                              remaining?.operation?.status === "pending" &&
                              remaining.operation.kind === "purge" &&
                              remaining.operation.operationId === operationId
                          ) {
                              await patchRef(remaining.id, (draft, updatedAt) => {
                                  draft.operation = {
                                      kind: "purge",
                                      status: "failed",
                                      operationId,
                                      error: `Interrupted blob purge could not be completed: ${errorMessage(error)}`,
                                  };
                                  draft.updatedAt = updatedAt;
                              });
                          }
                      }
                  }
              },
          }
        : undefined;

    const server: CoordinationServiceServer<BlobCoordinationService> | undefined =
        handlers && host
            ? host.serve<BlobCoordinationService>(BLOB_COORDINATION_SERVICE, handlers)
            : undefined;

    const write = async (
        id: string,
        blob: Blob | File,
        kind: BlobWriteKind
    ): Promise<BlobRef> => {
        const operation = await client.methods.beginWrite({
            id,
            kind,
            metadata: {
                type: blob.type,
                size: blob.size,
                name: blobName(blob),
            },
        });
        try {
            await bytes.write(operation.id, blob);
            return await client.methods.commitWrite(operation);
        } catch (error) {
            try {
                await client.methods.failWrite({
                    ...operation,
                    error: errorMessage(error),
                });
            } catch {
                // A stale failure must not delete bytes belonging to a
                // newer operation. Preserve the original operation error.
            }
            throw error;
        }
    };

    let cleanupPromise: Promise<void> | undefined;
    return {
        collection,
        ready,
        beginWrite: (input) => client.methods.beginWrite(input),
        commitWrite: (input) => client.methods.commitWrite(input),
        failWrite: (input) => client.methods.failWrite(input),
        stage: (id, blob) => write(id, blob, "stage"),
        cache: (id, blob) => write(id, blob, "cache"),
        find: (id) => client.methods.find({ id }),
        upsertMetadata: (id, metadata, remote) =>
            client.methods.upsertMetadata({ id, metadata, remote }),

        async read(id) {
            const ref = await client.methods.find({ id });
            const resolvedId = ref?.id ?? id;
            if (ref?.operation?.kind === "stage" || ref?.operation?.kind === "cache") {
                throw new BlobBytesUnavailableError(resolvedId, {
                    cause: new Error(`Blob ${ref.operation.kind} operation is ${ref.operation.status}.`),
                });
            }
            let blob: Blob;
            try {
                blob = await bytes.read(resolvedId);
            } catch (cause) {
                throw new BlobBytesUnavailableError(resolvedId, {
                    cause,
                });
            }
            if (ref) {
                await client.methods.touch({ id: ref.id });
            }
            return blob;
        },

        bindRemoteId: (localId, remoteId) =>
            client.methods.bindRemoteId({
                localId,
                remoteId,
            }),
        purge: (id, callOptions) => client.methods.purge({ id }, callOptions),
        async recoverAsLeader(signal) {
            if (!isCoordinationHost(options.runtime.coordination)) {
                return rejectTask(
                    "BLOB_RECOVERY_NOT_LEADER",
                    "A client-only Coordination value cannot recover blobs."
                );
            }
            const recoveryId = randomOperationId();
            activeRecoveryId = recoveryId;
            try {
                await client.methods.recover({ recoveryId }, { signal });
            } finally {
                if (activeRecoveryId === recoveryId) {
                    activeRecoveryId = undefined;
                }
            }
        },
        clearActiveOperations() {
            activeOperationIds.clear();
        },
        cleanup() {
            cleanupPromise ??= (async () => {
                activeOperationIds.clear();
                await server?.close();
                await collection.cleanup();
            })();
            return cleanupPromise;
        },
    };
}
