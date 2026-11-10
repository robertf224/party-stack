import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeCachedProxy, replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { sliceByteSource } from "@party-stack/ontology-storage/blobs";
import { Effect, Layer, Schema, Scope } from "effect";
import { projectOntologyBackend } from "./authorization.js";
import { withInternalCommands } from "./internalAccess.js";
import { validateContext } from "./policyDefinition.js";
import { ontologyRpcHandlers } from "./rpc.js";
import type { OntologyInternalAccess } from "./internalAccess.js";
import type { OntologyRpcServerOptions } from "./rpc.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OwnedBackendService } from "@party-stack/ontology-backend/owned";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaService } from "@party-stack/ontology-replica";

export type OntologyAuthenticate<R = never> = (
    request: Request
) => Effect.Effect<Record<string, unknown>, BackendError, R | Scope.Scope>;
export type { OntologyInternalAccess } from "./internalAccess.js";

type Common<R> = Omit<
    OntologyRpcServerOptions<R>,
    "source" | "backend" | "authorize" | "context" | "replica" | "errors"
>;
type Role =
    | { readonly kind: "owned"; readonly backend: OwnedBackendService }
    | { readonly kind: "proxy"; readonly backend: OntologyBackendService }
    | {
          readonly kind: "cached-proxy";
          readonly backend: OntologyBackendService;
          readonly cache: ReplicaService;
      }
    | {
          readonly kind: "replica";
          readonly backend: OntologyBackendService;
          readonly replica: ReplicaService;
          readonly dangerouslyAllowInternalAccess: true;
          readonly context?: never;
      };
type Binding =
    | {
          readonly context: Record<string, unknown>;
          readonly dangerouslyAllowInternalAccess?: OntologyInternalAccess;
      }
    | { readonly context?: never; readonly dangerouslyAllowInternalAccess: true };

/** Transport-neutral construction for an already authenticated principal or trusted peer. */
export type OntologyServerBindingOptions<R = never> = Common<R> & Role & Binding;
/** HTTP authentication runs per request; internal commands require explicit opt-in. */
export type OntologyBindingOptions<R = never> = Common<R> &
    Role &
    (
        | (Binding & { readonly authenticate?: never })
        | {
              readonly context?: never;
              readonly dangerouslyAllowInternalAccess: true;
              readonly authenticate?: OntologyAuthenticate<R>;
          }
        | {
              readonly context?: never;
              readonly dangerouslyAllowInternalAccess?: OntologyInternalAccess;
              readonly authenticate: OntologyAuthenticate<R>;
          }
    );

// Role composition is acquired once. In particular, every caller must share the
// cached proxy's invalidation generation, backend owner and maintenance lifecycle.
export const prepareOntologyServer = Effect.fn("OntologyServer.prepare")(function* <R>(
    options: Common<R> & Role
) {
    let backend: OntologyBackendService = options.backend;
    let source: OntologySource | undefined;
    if (options.kind === "cached-proxy")
        backend = yield* makeCachedProxy({ replica: options.cache, backend });
    else if (options.kind === "replica") {
        source = replicaStateSource(options.replica);
        backend = replicaServerBackend(options.replica, backend);
    }
    const ir =
        options.ir ??
        (options.kind === "owned"
            ? options.backend.storage.ir
            : options.kind === "replica"
              ? options.replica.ir
              : options.kind === "cached-proxy"
                ? options.cache.ir
                : undefined);
    return {
        ...options,
        backend,
        source,
        ir,
        context: options.kind === "replica" ? options.replica.context : undefined,
    };
});

export const bindOntologyServer = Effect.fn("OntologyServer.bind")(function* <R>(
    prepared: Effect.Success<ReturnType<typeof prepareOntologyServer<R>>>,
    context: Record<string, unknown> | undefined,
    internalAccess: OntologyInternalAccess | undefined
) {
    context ??= prepared.context;
    if (prepared.ir?.policy) context ??= {};
    if (context && prepared.ir) context = yield* validateContext(prepared.ir, context);
    const allowInternal =
        typeof internalAccess === "function"
            ? yield* Effect.try({
                  try: () => internalAccess(context ?? {}),
                  catch: (cause) => classifyBackendFailure("server.internalAccess", cause),
              }).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
                  Effect.mapError(
                      () =>
                          new BackendError({
                              operation: "server.internalAccess",
                              kind: "InvalidConfiguration",
                              retryable: false,
                              message: "The internal-access predicate must return a boolean.",
                          })
                  )
              )
            : internalAccess === true;
    if (!prepared.ir?.policy) {
        if (allowInternal)
            return { ...prepared, context, errors: "forward" as const, authorize: () => Effect.void };
        return yield* new BackendError({
            operation: "server.bind",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "An endpoint requires an IR policy or explicit internal access.",
        });
    }
    const view = yield* projectOntologyBackend(
        { backend: prepared.backend, ir: prepared.ir, context: context! },
        prepared.kind === "owned" ? "owned" : "upstream"
    );
    return {
        ...prepared,
        ...view,
        errors: "projected" as const,
        // Raw journals and speculative state are not policy-projected yet.
        source: undefined,
        backend: { ...view.backend, maintenance: prepared.backend.maintenance },
        authorize: withInternalCommands(view.authorize, allowInternal),
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
                    { optimistic: true }
                );
            }),
    };
};

/** One role/policy composition for transports with an already authenticated binding. */
export const ontologyServerHandlers = <R = never>(options: OntologyServerBindingOptions<R>) =>
    Layer.unwrap(
        prepareOntologyServer(options).pipe(
            Effect.flatMap((prepared) =>
                bindOntologyServer(prepared, options.context, options.dangerouslyAllowInternalAccess)
            ),
            Effect.map(ontologyRpcHandlers)
        )
    );
