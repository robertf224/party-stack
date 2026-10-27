import { BackendError } from "@party-stack/ontology-backend";
import { makeCachedProxy, replicaStateSource } from "@party-stack/ontology-replica";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";
import { makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologyRpcServerOptions } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OwnedBackendService } from "@party-stack/ontology-backend/owned";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaService } from "@party-stack/ontology-replica";

type Common<R> = Omit<OntologyRpcServerOptions<R>, "source" | "backend">;
export type OntologyServerOptions<R = never> = Common<R> &
    (
        | { readonly kind: "owned"; readonly backend: OwnedBackendService }
        | {
              readonly kind: "proxy";
              readonly backend: OntologyBackendService;
          }
        | {
              readonly kind: "cached-proxy";
              readonly backend: OntologyBackendService;
              readonly cache: ReplicaService;
              readonly demand?: { readonly idleDemandMs?: number; readonly maxSubsets?: number };
          }
        | {
              readonly kind: "replica";
              readonly backend: OntologyBackendService;
              readonly replica: ReplicaService;
          }
    );

/** Roles define execution responsibility. Authorization defines which operations
 * are exposed, including read-only access. Scope owns demand and server resources.
 */
export const makeOntologyServer = Effect.fn("OntologyServer.make")(function* <R = never>(
    options: OntologyServerOptions<R>
) {
    let backend: OntologyBackendService = options.backend;
    let source: OntologySource | undefined;
    if (options.kind === "cached-proxy") {
        backend = yield* makeCachedProxy({ replica: options.cache, backend, ...options.demand });
    } else if (options.kind === "replica") {
        const replica = options.replica;
        source = replicaStateSource(replica);
        backend = {
            ...backend,
            supportsIdempotency: true,
            // The ordinary adapter facet stays committed: rows and cursors come
            // from upstream. Published predictions travel only through source.
            // Local staged/cached attachments still belong to this server.
            attachments: options.ontology
                ? {
                      stage: (value, bytes) =>
                          Effect.tryPromise({
                              try: async () =>
                                  (await options.ontology!.attachments.create(bytes, { id: value.id }))
                                      .attachment,
                              catch: (cause) =>
                                  cause instanceof BackendError
                                      ? cause
                                      : new BackendError({
                                            operation: "attachment.stage",
                                            kind: "Unavailable",
                                            retryable: true,
                                            actionOutcome: "not-committed",
                                            message: "Attachment staging failed.",
                                            cause,
                                        }),
                          }),
                      read: (value, range) =>
                          Effect.tryPromise({
                              try: (signal) => options.ontology!.attachments.source(value, { signal }),
                              catch: (cause) =>
                                  cause instanceof BackendError
                                      ? cause
                                      : new BackendError({
                                            operation: "attachment.read",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Attachment read failed.",
                                            cause,
                                        }),
                          }).pipe(
                              Effect.map((source) =>
                                  range ? sliceByteSource(source, range.offset ?? 0, range.length) : source
                              )
                          ),
                      metadata: (value, settings) =>
                          Effect.tryPromise({
                              try: () =>
                                  options.ontology!.attachments.metadata(value, {
                                      select: (settings?.select as readonly ("size" | "type" | "name")[]) ?? [
                                          "size",
                                          "type",
                                          "name",
                                      ],
                                  }),
                              catch: (cause) =>
                                  cause instanceof BackendError
                                      ? cause
                                      : new BackendError({
                                            operation: "attachment.metadata",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Attachment metadata failed.",
                                            cause,
                                        }),
                          }),
                  }
                : backend.attachments,
            // Finite request/response callers await confirmation. Replica children
            // use Submit for durable acceptance and normal parent-state handoff.
            applyAction: (invocation) =>
                Effect.gen(function* () {
                    if (invocation.attachmentUploads?.length) {
                        if (!options.ontology)
                            return yield* new BackendError({
                                operation: "applyAction.upload",
                                kind: "NotImplemented",
                                message:
                                    "A replica server needs local attachment storage to accept action uploads.",
                                retryable: false,
                                actionOutcome: "not-committed",
                            });
                        for (const upload of invocation.attachmentUploads)
                            yield* Effect.tryPromise({
                                try: () =>
                                    options.ontology!.attachments.create(upload.blob, {
                                        id: upload.attachment.id,
                                    }),
                                catch: (cause) =>
                                    cause instanceof BackendError
                                        ? cause
                                        : new BackendError({
                                              operation: "applyAction.upload",
                                              kind: "Unavailable",
                                              message: "Local attachment staging failed.",
                                              retryable: false,
                                              actionOutcome: "not-committed",
                                              cause,
                                          }),
                            });
                    }
                    yield* replica.enqueue(
                        { ...invocation, attachmentUploads: undefined },
                        { optimistic: true }
                    );
                    const receipt = yield* replica.awaitAction(invocation.id);
                    if (!receipt)
                        return yield* new BackendError({
                            operation: "applyAction",
                            kind: "ResultExpired",
                            message: "Action result is unavailable.",
                            retryable: false,
                            actionOutcome: "unknown",
                        });
                    return receipt;
                }),
        };
    }
    const handleRequest = yield* makeOntologyHttpHandler({
        ...options,
        ir:
            options.ir ??
            (options.kind === "owned"
                ? options.backend.storage.ir
                : options.kind === "replica"
                  ? options.replica.ir
                  : options.kind === "cached-proxy"
                    ? options.cache.ir
                    : undefined),
        backend,
        source,
    });
    return { handleRequest };
});
