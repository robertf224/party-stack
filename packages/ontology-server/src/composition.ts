import { BackendError } from "@party-stack/ontology-backend";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { makeCachedProxy, replicaStateSource } from "@party-stack/ontology-replica";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";
import { projectOntologyBackend } from "./authorization.js";
import { backendQueryReader } from "./query.js";
import { makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologyRpcServerOptions } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OwnedBackendService } from "@party-stack/ontology-backend/owned";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaService } from "@party-stack/ontology-replica";

type Common<R> = Omit<OntologyRpcServerOptions<R>, "source" | "backend" | "authorize" | "context"> &
    (
        | { readonly context: Record<string, unknown>; readonly authorize?: never }
        | { readonly context?: undefined; readonly authorize: OntologyRpcServerOptions<R>["authorize"] }
    );
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
          }
        | {
              readonly kind: "replica";
              readonly backend: OntologyBackendService;
              readonly replica: ReplicaService;
              readonly context?: never;
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
        backend = yield* makeCachedProxy({ replica: options.cache, backend });
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
    let ir =
        options.ir ??
        (options.kind === "owned"
            ? options.backend.storage.ir
            : options.kind === "replica"
              ? options.replica.ir
              : options.kind === "cached-proxy"
                ? options.cache.ir
                : options.ontology?.ir);
    let context = options.context;
    let query = options.query;
    let authorize = options.authorize;
    if (options.context) {
        if (source || !ir)
            return yield* new BackendError({
                operation: "server.project",
                kind: "InvalidConfiguration",
                message: "A projected server requires an ordinary backend and its ontology definition.",
                retryable: false,
            });
        // Authorization wraps the role's final read path, including cache hits.
        // Applying it to only the upstream adapter would leave cached rows unguarded.
        const maintenance = backend.maintenance;
        const view = yield* projectOntologyBackend(
            { backend, ir, context: options.context, errors: options.errors },
            options.kind === "owned" ? "owned" : "upstream"
        );
        backend = { ...view.backend, maintenance };
        ir = view.ir;
        context = view.context;
        query = view.query;
        authorize = view.authorize;
    }
    if (!authorize)
        return yield* new BackendError({
            operation: "server.authorize",
            kind: "InvalidConfiguration",
            message: "A trusted transport gate or authenticated policy binding is required.",
            retryable: false,
        });
    if (!query && ir) {
        const definition = ir;
        if (options.kind === "owned") {
            const storage = options.backend.storage;
            query = (document, inputs) =>
                storage.read((tx) =>
                    executeQuery(document, {
                        reader: { ir: definition, loadSubset: (type, subset) => tx.loadSubset(type, subset) },
                        inputs,
                    }).pipe(Effect.map((result) => result.value))
                );
        } else {
            const reader = backendQueryReader(definition, backend);
            query = (document, inputs) =>
                executeQuery(document, { reader, inputs }).pipe(Effect.map((result) => result.value));
        }
    }
    const handleRequest = yield* makeOntologyHttpHandler({
        ...options,
        ir,
        context,
        query,
        authorize,
        backend,
        source,
    });
    return { handleRequest, backend };
});
