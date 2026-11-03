import { BackendError } from "@party-stack/ontology-backend";
import { executeQuery } from "@party-stack/ontology-backend/query";
import { makeCachedProxy, replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Layer } from "effect";
import { projectOntologyBackend } from "./authorization.js";
import { backendQueryReader } from "./query.js";
import { ontologyRpcHandlers } from "./rpc.js";
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
const configureOntologyServer = Effect.fn("OntologyServer.configure")(function* <R = never>(
    options: OntologyServerOptions<R>
) {
    let backend: OntologyBackendService = options.backend;
    let source: OntologySource | undefined;
    if (options.kind === "cached-proxy") {
        backend = yield* makeCachedProxy({ replica: options.cache, backend });
    } else if (options.kind === "replica") {
        const replica = options.replica;
        source = replicaStateSource(replica);
        backend = replicaServerBackend(replica, backend);
    }
    let ir =
        options.ir ??
        (options.kind === "owned"
            ? options.backend.storage.ir
            : options.kind === "replica"
              ? options.replica.ir
              : options.kind === "cached-proxy"
                ? options.cache.ir
                : undefined);
    let context = options.kind === "replica" ? options.replica.context : options.context;
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
                        reader: {
                            ir: definition,
                            loadSubset: (type, subset) => tx.loadSubset(type, subset),
                            loadGroupedSubset: tx.loadGroupedSubset,
                        },
                        inputs,
                    }).pipe(Effect.map((result) => result.value))
                );
        } else {
            const reader = backendQueryReader(definition, backend);
            query = (document, inputs) =>
                executeQuery(document, { reader, inputs }).pipe(Effect.map((result) => result.value));
        }
    }
    return {
        ...options,
        ir,
        context,
        query,
        authorize,
        backend,
        source,
    };
});

/** Ordinary provider capabilities of a replica server; speculative state remains a separate extension. */
export const replicaServerBackend = (
    replica: ReplicaService,
    backend: OntologyBackendService
): OntologyBackendService => {
    return {
        ...backend,
        supportsIdempotency: true,
        // The ordinary adapter facet stays committed: rows and cursors come
        // from upstream. Published predictions travel only through source.
        // Local staged/cached attachments still belong to this server.
        attachments: {
            stage: (value, bytes) =>
                replica.attachments
                    .create(bytes, { id: value.id })
                    .pipe(Effect.map((created) => created.attachment)),
            read: (value, range) =>
                replica.attachments
                    .source(value)
                    .pipe(
                        Effect.map((source) =>
                            range ? sliceByteSource(source, range.offset ?? 0, range.length) : source
                        )
                    ),
            metadata: (value, settings) =>
                replica.attachments.metadata(value, settings).pipe(
                    Effect.map(({ name, dimensions, ...rest }) => ({
                        ...rest,
                        name: name ?? undefined,
                        dimensions: dimensions ?? undefined,
                    }))
                ),
        },
        applyAction: (invocation) =>
            Effect.gen(function* () {
                for (const upload of invocation.attachmentUploads ?? [])
                    yield* replica.attachments.create(upload.blob, { id: upload.attachment.id });
                return yield* replica.actions.apply(
                    { ...invocation, attachmentUploads: undefined },
                    { mode: "outbox", optimistic: true }
                );
            }),
    };
};

/** The same role and authorization composition for any Effect RPC transport. */
export const ontologyServerHandlers = <R = never>(options: OntologyServerOptions<R>) =>
    Layer.unwrap(Effect.map(configureOntologyServer(options), ontologyRpcHandlers));

/** HTTP binding, including streamed action uploads. */
export const makeOntologyServer = Effect.fn("OntologyServer.make")(function* <R = never>(
    options: OntologyServerOptions<R>
) {
    const configured = yield* configureOntologyServer(options);
    const handleRequest = yield* makeOntologyHttpHandler(configured);
    return { handleRequest, backend: configured.backend };
});
