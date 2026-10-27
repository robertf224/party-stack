import { BackendError } from "@party-stack/ontology-backend";
import { makeCachedProxy, replicaStateSource } from "@party-stack/ontology-replica";
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
              readonly cache?: ReplicaService;
              readonly demand?: { readonly idleDemandMs?: number; readonly maxSubsets?: number };
              /** A protocol proxy can delegate upstream sessions without another registry. */
              readonly source?: OntologySource;
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
    if (options.kind === "owned") source = options.backend.protocol;
    else if (options.kind === "proxy") {
        source = options.source;
        if (options.cache)
            backend = yield* makeCachedProxy({ replica: options.cache, backend, ...options.demand });
    } else {
        const replica = options.replica;
        source = replicaStateSource(replica);
        backend = yield* makeCachedProxy({ replica, backend, confirmed: false });
        backend = {
            ...backend,
            supportsIdempotency: true,
            // Upstream commits do not describe this replica's optimistic state.
            // Protocol children consume its selected replica-state stream instead.
            changes: undefined,
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
                  : undefined),
        backend,
        source,
    });
    return { handleRequest };
});
