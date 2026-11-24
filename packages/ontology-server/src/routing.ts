import { BackendError, projectBackendError } from "@party-stack/ontology-backend";
import { CurrentExecutionContext } from "@party-stack/ontology-backend/policy";
import { makeReplicaPartitionCatalog } from "@party-stack/ontology-replica/registry";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { Runtimes } from "@party-stack/runtime";
import { Context, Effect, Equal, Exit, Hash, Layer, Option, RcMap, Schema, Scope, Stream } from "effect";
import { Rpc, RpcGroup, RpcSchema } from "effect/rpc";
import { prepareOntologyServer, bindOntologyServer } from "./composition.js";
import { errorProjectionLayer, errorContext, OntologyErrorProjection } from "./errorProjection.js";
import { restoreReplicaRegistration } from "./replicaBootstrap.js";
import { OntologyRpcs, ontologyRpcHandlers } from "./rpc.js";
import type { OntologyAuthenticate, OntologyBindingOptions, OntologyInternalAccess } from "./composition.js";
import type { ErrorProjectionOptions } from "./errorProjection.js";
import type { UpstreamReplicaRegistration } from "./replicaBootstrap.js";
import type { OntologyRpcClient, OntologyRpcServerOptions } from "./rpc.js";
import type { PinRecord } from "@party-stack/ontology-replica";
import type { ReplicaRegistration, StoredReplicaPartition } from "@party-stack/ontology-replica/registry";
import type { OntologyIR } from "@party-stack/ontology-spec";

/** Routing belongs to the transport envelope, not to individual ontology operations. */
export const ontologyHeader = "x-party-stack-ontology";
const ontologyParameter = "ontology";
const nameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const name = (value: unknown) =>
    Schema.decodeUnknownEffect(nameSchema)(value).pipe(
        Effect.mapError(
            () =>
                new BackendError({
                    operation: "ontology.route",
                    kind: "InvalidRequest",
                    retryable: false,
                    message: "An ontology name is required.",
                })
        )
    );

export interface OntologyResolver<T, R = never> {
    (ontology: string): Effect.Effect<T, BackendError, R | Scope.Scope>;
}

/** Select a target before Describe; the server may resolve that name dynamically. */
export function selectOntology(client: OntologyRpcClient, ontology: string): OntologyRpcClient {
    return Object.fromEntries(
        [...OntologyRpcs.requests.keys()].map((tag) => [
            tag,
            (payload: unknown, settings?: { readonly headers?: Record<string, string> }) =>
                Reflect.apply(Reflect.get(client, tag), client, [
                    payload,
                    {
                        ...settings,
                        headers: { ...settings?.headers, [ontologyHeader]: ontology },
                    },
                ]),
        ])
    ) as OntologyRpcClient;
}

/** URL selection also covers multipart uploads, not just RPC frames. */
export function ontologyUrl(url: string, ontology?: string): string {
    if (ontology === undefined) return url;
    const target = new URL(url);
    target.searchParams.set(ontologyParameter, ontology);
    return target.href;
}

/** Native acquisition owns sharing. Re-resolve on every request so a replacement
 * owner is visible even while an older endpoint still has subscribed readers.
 * Binding settings stay stable for one native owner's lifetime; command Effects
 * are deliberately not identities (resolvers commonly construct them per call).
 */
class EndpointKey<T extends OntologyBindingOptions<unknown>> implements Equal.Equal {
    readonly identity;
    constructor(
        readonly ontology: string,
        readonly options: T,
        readonly context: Record<string, unknown> | undefined
    ) {
        this.identity = [
            ontology,
            options.kind,
            options.backend,
            options.kind === "replica"
                ? options.replica
                : options.kind === "cached-proxy"
                  ? options.cache
                  : undefined,
            options.ir,
            JSON.stringify(context),
            options.authenticate,
            options.dangerouslyAllowInternalAccess,
            options.enableRealtime,
            options.upstreamErrors,
            options.deliveryStrategy,
            options.delivery,
            options.attachmentTransfers,
            options.traces,
        ];
    }
    [Hash.symbol]() {
        return Hash.array(this.identity);
    }
    [Equal.symbol](other: Equal.Equal) {
        return (
            other instanceof EndpointKey &&
            this.identity.every((value, index) => Equal.equals(value, other.identity[index]))
        );
    }
}

/** Supplied by HTTP bindings; worker routes use already authenticated contexts. */
export const OntologyTransportRequest = Context.Reference<Request | undefined>(
    "@party-stack/ontology-server/TransportRequest",
    { defaultValue: () => undefined }
);
export const OntologyTransportTarget = Context.Reference<string | undefined>(
    "@party-stack/ontology-server/TransportTarget",
    { defaultValue: () => undefined }
);
export const OntologyTransportBinding = Context.Reference<
    { readonly ontology: string; readonly bound: BoundOntology<unknown> } | undefined
>("@party-stack/ontology-server/TransportBinding", { defaultValue: () => undefined });
type Rpcs = RpcGroup.Rpcs<typeof OntologyRpcs>;
interface BoundOntology<R> {
    readonly options: OntologyRpcServerOptions<R>;
    readonly handlers: Context.Context<Rpc.ToHandler<Rpcs> | OntologyErrorProjection>;
    readonly executionContext: Record<string, unknown> | undefined;
}

/** A transport-neutral dispatcher. The surrounding Scope owns its endpoint bindings. */
export interface OntologyServer<R = never> extends ErrorProjectionOptions {
    readonly _tag: "OntologyServer";
    readonly defaultOntology?: string;
    readonly invalidate: (ontology: string) => Effect.Effect<void, BackendError>;
    readonly forget: (ontology: string) => Effect.Effect<void, BackendError>;
    readonly partitions: Effect.Effect<readonly StoredReplicaPartition[], BackendError>;
    /** Run a bounded native checkpoint through the route's existing replica owner. */
    /** Checkpoint one ontology. `revalidate` reloads demanded data even when a realtime
     * watch reports it current; use it for user-initiated refresh. Resolves to the
     * replica's named downloads, each with its readiness and error after the checkpoint. */
    readonly syncOnce: (
        ontology: string,
        options?: { readonly revalidate?: boolean }
    ) => Effect.Effect<{ readonly pins: readonly PinRecord[] }, BackendError, R>;
    readonly bind: (
        ontology: string,
        request?: Request
    ) => Effect.Effect<BoundOntology<R>, BackendError, R | Scope.Scope>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/**
 * A replica the server's partition catalog creates, stores and reopens: fed by a `backend`, or by
 * another party-stack server through `upstream`. The protocol source and saved bootstrap are
 * filled in by the server and are not part of a route.
 */
export type ManagedReplicaRoute<R = never> = DistributiveOmit<
    ReplicaRegistration | UpstreamReplicaRegistration,
    "source" | "bootstrap"
> &
    Omit<
        OntologyRpcServerOptions<R>,
        "source" | "replica" | "backend" | "authorize" | "context" | "ir" | "errors"
    > & {
        readonly kind: "replica";
        readonly replica?: never;
        readonly dangerouslyAllowInternalAccess?: never;
        readonly authenticate?: never;
    };
/** What a route's `open` returns. Access and authentication are settings of the route itself. */
export type OpenedOntologyRoute<R = never> =
    | (DistributiveOmit<OntologyBindingOptions<R>, "dangerouslyAllowInternalAccess" | "authenticate"> & {
          readonly dangerouslyAllowInternalAccess?: never;
          readonly authenticate?: never;
      })
    | ManagedReplicaRoute<R>;
/** A route that needs no opening: a ready binding, or a managed replica registration. */
export type OntologyRoute<R = never> =
    | OntologyBindingOptions<R>
    | (DistributiveOmit<ManagedReplicaRoute<R>, "dangerouslyAllowInternalAccess"> & {
          readonly dangerouslyAllowInternalAccess: true;
      });
type SegmentParameter<Segment extends string> = Segment extends `:${infer Name}` | `*${infer Name}`
    ? Name
    : never;
type RouteParameter<Path extends string> = Path extends `${infer Head}/${infer Tail}`
    ? SegmentParameter<Head> | RouteParameter<Tail>
    : SegmentParameter<Path>;
export type OntologyRouteParams<Path extends string> = string extends Path
    ? Readonly<Record<string, string>>
    : Readonly<{ [Name in RouteParameter<Path>]: string }>;

export interface OntologyRouteContext {
    /** Use this account's retained IR before acquiring a schema-dependent native backend. */
    readonly definition: <R>(options: {
        readonly context: Record<string, unknown>;
        readonly load: Effect.Effect<OntologyIR, BackendError, R>;
    }) => Effect.Effect<OntologyIR, BackendError, R | Runtimes>;
}

/**
 * A route whose backend is acquired on demand. For each request the server authenticates the
 * caller, opens the route (once per address, kept for `idleRetentionMs`), then binds.
 */
export interface OntologyRouteDeclaration<
    R = never,
    Path extends string = string,
    Opened extends OpenedOntologyRoute<R> = OpenedOntologyRoute<R>,
> {
    /**
     * Allow internal commands (replica status, traces, outbox recovery, local-data deletion, owner
     * release) for every caller (`true`) or for callers whose context passes the predicate. A route
     * without an IR policy requires it, and then exposes raw backend capabilities and full error
     * messages. Replica routes require `true`.
     *
     * A caller allowed internal access also gets the original error when the route fails to open
     * (for example because its definition failed to load). A predicate can only allow that when
     * `authenticate` supplies the caller's context.
     */
    readonly dangerouslyAllowInternalAccess?: OntologyInternalAccess;
    /** Establish each request's context before the route opens. Without it, `open` supplies a fixed context. */
    readonly authenticate?: OntologyAuthenticate<R>;
    /** Acquire the route's backend and binding. */
    readonly open:
        | Effect.Effect<Opened, BackendError, R | Scope.Scope>
        | ((
              params: OntologyRouteParams<Path>,
              route: OntologyRouteContext
          ) => Effect.Effect<Opened, BackendError, R | Scope.Scope>);
}
export type OntologyRouteFactory<
    R = never,
    Path extends string = string,
    Opened extends OpenedOntologyRoute<R> = OpenedOntologyRoute<R>,
> =
    | OntologyBindingOptions<R>
    | (ManagedReplicaRoute<R> extends Opened ? OntologyRoute<R> : never)
    | OntologyRouteDeclaration<R, Path, Opened>;
export interface OntologyServerRoutes<
    R = never,
    Paths extends string = string,
    Opened extends OpenedOntologyRoute<R> = OpenedOntologyRoute<R>,
> extends Omit<ErrorProjectionOptions, "errors"> {
    /** Opt into client watches and replication sessions. Individual routes may override this default. */
    readonly enableRealtime?: boolean;
    readonly routes?: { readonly [Path in Paths]: OntologyRouteFactory<R, Path, Opened> };
    /** Advanced resolution for addresses outside the declared route table. */
    readonly resolve?: OntologyResolver<OntologyBindingOptions<R>, R>;
    /** Keep an opened route for this long after its last request. Default 60 seconds; zero
     * releases it immediately. A route that fails to open is not kept, so the next request
     * opens it again.
     */
    readonly idleRetentionMs?: number;
    /** Optional storage namespacing. Managed replica routes acquire their catalog automatically. */
    readonly replicas?: { readonly scope?: string };
}

export type OntologyServerOptions<R = never> = OntologyServerRoutes<R> | OntologyBindingOptions<R>;

const normalizePath = (path: string) => path.replace(/^\/+|\/+$/g, "");
const compileRoutes = <R>(routes: Readonly<Record<string, OntologyRouteFactory<R>>>) => {
    const exact = new Map<string, { factory: OntologyRouteFactory<R>; pattern: string }>();
    const patterns: {
        regex: RegExp;
        names: string[];
        factory: OntologyRouteFactory<R>;
        pattern: string;
        score: number;
    }[] = [];
    const shapes = new Set<string>();
    for (const [raw, factory] of Object.entries(routes)) {
        const pattern = normalizePath(raw);
        const names: string[] = [];
        const segments = pattern.split("/");
        const regex = segments
            .map((segment, index) => {
                if (segment.startsWith(":") || segment.startsWith("*")) {
                    const name = segment.slice(1);
                    if (
                        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
                        names.includes(name) ||
                        (segment.startsWith("*") && index !== segments.length - 1)
                    )
                        throw new TypeError("Invalid ontology route parameter.");
                    names.push(name);
                    return segment.startsWith("*") ? "(.+)" : "([^/]+)";
                }
                return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            })
            .join("/");
        if (!names.length) {
            if (exact.has(pattern)) throw new TypeError("Duplicate ontology route.");
            exact.set(pattern, { factory, pattern });
        } else {
            if (shapes.has(regex)) throw new TypeError("Ambiguous ontology routes.");
            shapes.add(regex);
            patterns.push({
                regex: new RegExp(`^${regex}$`),
                names,
                factory,
                pattern,
                score: segments.filter((part) => !part.startsWith(":") && !part.startsWith("*")).length,
            });
        }
    }
    patterns.sort((a, b) => b.score - a.score || b.pattern.length - a.pattern.length);
    return { exact, patterns };
};

const isRouteDeclaration = <R>(factory: OntologyRouteFactory<R>): factory is OntologyRouteDeclaration<R> =>
    "open" in factory;

const allowsInternalAccess = (
    access: OntologyInternalAccess | undefined,
    context: Record<string, unknown> | undefined
) => {
    if (access === true) return true;
    if (typeof access !== "function" || context === undefined) return false;
    try {
        return access(context) === true;
    } catch {
        return false;
    }
};

const constructServer = Effect.fn("OntologyServer.make")(function* <R = never>(
    options: OntologyServerRoutes<R> | OntologyBindingOptions<R>
) {
    const single = "kind" in options;
    const settings: OntologyServerRoutes<R> = single ? {} : options;
    // Startup failures a route chose to show its caller in full; every other failure
    // before a route is bound gets the generic projection.
    const forwardedStartupErrors = new WeakSet<BackendError>();
    const ttl = settings.idleRetentionMs ?? 60_000;
    if (
        !Number.isFinite(ttl) ||
        ttl < 0 ||
        (settings.replicas?.scope !== undefined && !Schema.is(Schema.NonEmptyString)(settings.replicas.scope))
    )
        return yield* new BackendError({
            operation: "server.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Server replica scope and idle retention are invalid.",
        });
    const compiled = yield* Effect.try({
        try: () => compileRoutes(settings.routes ?? {}),
        catch: (cause) =>
            new BackendError({
                operation: "server.configure",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Invalid ontology routes.",
                cause,
            }),
    });
    const serverScope = yield* Effect.scope;
    const runtimes = yield* Effect.serviceOption(Runtimes);
    // Capture storage at server construction, but only open the inventory when
    // a managed route or an inventory operation needs it. Route declarations,
    // not the presence of an options object, determine the service requirement.
    const getCatalog = yield* Effect.cached(
        Scope.provide(
            Option.isSome(runtimes)
                ? makeReplicaPartitionCatalog(settings.replicas?.scope).pipe(
                      Effect.provideService(Runtimes, runtimes.value)
                  )
                : Effect.fail(
                      new BackendError({
                          operation: "server.configure",
                          kind: "InvalidConfiguration",
                          retryable: false,
                          message: "Managed replica routes require Runtimes.",
                      })
                  ),
            serverScope
        )
    );
    // Role composition is shared across authenticated bindings. Cache invalidation
    // belongs to the cache owner, rather than to an individual caller.
    const roles = yield* RcMap.make({
        lookup: (key: EndpointKey<OntologyBindingOptions<R>>) => prepareOntologyServer(key.options),
    });
    const endpoints = yield* RcMap.make({
        lookup: Effect.fnUntraced(function* (key: EndpointKey<OntologyBindingOptions<R>>) {
            const role = yield* RcMap.get(roles, new EndpointKey(key.ontology, key.options, undefined));
            const prepared = {
                ...role,
                ...key.options,
                enableRealtime: key.options.enableRealtime ?? settings.enableRealtime ?? false,
                backend: role.backend,
                source: role.source,
                ir: key.options.ir ?? role.ir,
            };
            const configured = yield* bindOntologyServer(
                prepared,
                key.context,
                key.options.dangerouslyAllowInternalAccess
            );
            return {
                options: configured,
                handlers: yield* Layer.buildWithScope(ontologyRpcHandlers(configured), yield* Effect.scope),
                executionContext:
                    prepared.kind === "owned" && prepared.ir?.context?.type ? configured.context : undefined,
            };
        }),
    });
    const matched = (target: string) =>
        Effect.try({
            try: () => {
                const path = normalizePath(target);
                const staticRoute = compiled.exact.get(path);
                if (staticRoute)
                    return { key: path, factory: staticRoute.factory, params: {} as Record<string, string> };
                for (const route of compiled.patterns) {
                    const match = route.regex.exec(path);
                    if (!match) continue;
                    const params = Object.fromEntries(
                        route.names.map((key, index) => [key, decodeURIComponent(match[index + 1]!)])
                    );
                    const key = route.pattern
                        .split("/")
                        .map((part) =>
                            part.startsWith(":") || part.startsWith("*")
                                ? encodeURIComponent(params[part.slice(1)]!)
                                : part
                        )
                        .join("/");
                    return { key, factory: route.factory, params };
                }
            },
            catch: (cause) =>
                new BackendError({
                    operation: "ontology.route",
                    kind: "InvalidRequest",
                    retryable: false,
                    message: "Invalid ontology address.",
                    cause,
                }),
        });
    const openRoute = Effect.fn("OntologyServer.openRoute")(function* (target: string) {
        const route = yield* matched(target);
        if (!route)
            return yield* new BackendError({
                operation: "ontology.route",
                kind: "NotFound",
                retryable: false,
                message: "Unknown ontology.",
            });
        const factory = route.factory;
        const definition: OntologyRouteContext = {
            definition: (options) =>
                Effect.gen(function* () {
                    const catalog = yield* getCatalog;
                    const saved = yield* catalog.lookup(route.key);
                    const retained = saved?.rebuild?.description.ir
                        ? {
                              ir: saved.rebuild.description.ir,
                              context: saved.rebuild.description.context ?? {},
                          }
                        : saved?.definition;
                    if (retained && contextPartition(retained.ir, options.context) === saved!.partition.owner)
                        return retained.ir;
                    return yield* options.load;
                }),
        };
        const declaration = (
            !isRouteDeclaration(factory)
                ? factory
                : typeof factory.open === "function"
                  ? yield* factory.open(route.params, definition)
                  : yield* factory.open
        ) as OntologyRoute<R>;
        const access = factory.dangerouslyAllowInternalAccess;
        const settings = { dangerouslyAllowInternalAccess: access, authenticate: factory.authenticate };
        if (declaration.kind === "replica" && access !== true)
            return yield* new BackendError({
                operation: "server.configure",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Replica routes require dangerouslyAllowInternalAccess: true.",
            });
        let binding: OntologyBindingOptions<R>;
        if (declaration.kind === "replica" && !declaration.replica) {
            const catalog = yield* getCatalog;
            let rebuilding = false;
            const restored =
                "upstream" in declaration
                    ? yield* restoreReplicaRegistration(route.key, declaration, catalog, (_client, error) =>
                          Effect.gen(function* () {
                              if (
                                  error.kind !== "SchemaMismatch" ||
                                  declaration.onDefinitionChange !== "reset" ||
                                  rebuilding
                              )
                                  return;
                              rebuilding = true;
                              // A protocol error is evidence, not a startup prerequisite.
                              // Resolve the replacement only after such evidence arrives.
                              yield* Effect.gen(function* () {
                                  const fresh = yield* declaration.upstream.client.ontology(
                                      declaration.upstream.ontology
                                  );
                                  if (!fresh.ir) return;
                                  // A bundled application cannot silently acquire a different contract.
                                  if (declaration.ir) return;
                                  let retired = false;
                                  yield* catalog
                                      .rebuild(route.key, fresh.description, {
                                          onRetire: Effect.sync(() => {
                                              retired = true;
                                          }),
                                      })
                                      .pipe(
                                          Effect.ensuring(
                                              Effect.suspend(() =>
                                                  retired ? retire(route.key) : Effect.void
                                              )
                                          )
                                      );
                              }).pipe(
                                  Effect.scoped,
                                  Effect.ensuring(
                                      Effect.sync(() => {
                                          rebuilding = false;
                                      })
                                  ),
                                  Effect.catch((failure) =>
                                      Effect.logWarning("Replica definition rebuild blocked", failure)
                                  ),
                                  Effect.forkIn(serverScope)
                              );
                          }).pipe(Effect.asVoid)
                      )
                    : undefined;
            const registration = restored?.registration ?? (declaration as ReplicaRegistration);
            const resource = yield* catalog
                .open(route.key, registration)
                .pipe(Effect.tapError((error) => (restored ? restored.failed(error) : Effect.void)));
            if (restored) yield* restored.opened;
            binding = {
                ...declaration,
                ...settings,
                ir: resource.ir,
                replica: resource.replica,
                backend: resource.backend,
                traces: resource.traces,
                deleteLocalData: forget(route.key),
            } as unknown as OntologyBindingOptions<R>;
        } else binding = { ...declaration, ...settings } as OntologyBindingOptions<R>;
        if (!binding.authenticate) {
            const context = binding.kind === "replica" ? binding.replica.context : binding.context;
            const bound = yield* RcMap.get(endpoints, new EndpointKey(route.key, binding, context));
            // A fixed route owns its handler resources, including chunk-transfer
            // registries, for the same lifetime as its backend.
            binding = { ...binding, context: bound.options.context } as OntologyBindingOptions<R>;
        }
        return binding;
    });
    // An opened route stays warm for `idleRetentionMs` after its last request. RcMap keeps a
    // failed lookup the same way, so every retry would get the cached failure and restart its
    // idle timer. Drop a failed open instead; the attempt number keeps a late failure from
    // removing a newer open of the same route.
    let openAttempts = 0;
    const latestOpen = new Map<string, number>();
    const resources = yield* RcMap.make({
        idleTimeToLive: ttl,
        lookup: (target: string): ReturnType<typeof openRoute> =>
            Effect.suspend(() => {
                const attempt = ++openAttempts;
                latestOpen.set(target, attempt);
                return openRoute(target).pipe(
                    Effect.onExit((exit) =>
                        Effect.suspend(() => {
                            if (latestOpen.get(target) !== attempt) return Effect.void;
                            latestOpen.delete(target);
                            // RcMap already drops an interrupted lookup.
                            return Exit.isFailure(exit) && !Exit.hasInterrupts(exit)
                                ? RcMap.invalidate(resources, target)
                                : Effect.void;
                        })
                    )
                );
            }),
    });
    const retire = (key: string): Effect.Effect<void> => RcMap.invalidate(resources, key);
    const invalidate = (target: string): Effect.Effect<void, BackendError> =>
        Effect.flatMap(matched(target), (route) => retire(route?.key ?? normalizePath(target)));
    const forget = (target: string): Effect.Effect<void, BackendError> =>
        Effect.gen(function* () {
            const route = yield* matched(target);
            const key = route?.key ?? normalizePath(target);
            if (Option.isSome(runtimes)) {
                const catalog = yield* getCatalog;
                yield* catalog.forget(key);
            }
            yield* RcMap.invalidate(resources, key);
        });
    const authenticateRequest = (authenticate: OntologyAuthenticate<R>, request: Request | undefined) =>
        Effect.gen(function* () {
            if (!request)
                return yield* new BackendError({
                    operation: "ontology.authenticate",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "This ontology requires an HTTP authentication binding.",
                });
            const context = yield* authenticate(request);
            yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(context).pipe(
                Effect.mapError(
                    () =>
                        new BackendError({
                            operation: "ontology.authenticate",
                            kind: "InvalidConfiguration",
                            retryable: false,
                            message: "Authentication must return an ontology context.",
                        })
                )
            );
            return context;
        });
    const bind = Effect.fn("OntologyServer.bind")(function* (ontology: string, request?: Request) {
        if (!single) yield* name(ontology);
        const route = single ? undefined : yield* matched(ontology);
        if (route) {
            // Authenticate before opening, so an unauthenticated request never opens a route
            // and an open failure can be shown in full to a caller allowed internal access.
            const { authenticate, dangerouslyAllowInternalAccess: access } = route.factory;
            const caller = authenticate ? yield* authenticateRequest(authenticate, request) : undefined;
            const target = yield* RcMap.get(resources, route.key).pipe(
                Effect.tapError((error) =>
                    Effect.sync(() => {
                        if (allowsInternalAccess(access, caller)) forwardedStartupErrors.add(error);
                    })
                )
            );
            const context = caller ?? (target.kind === "replica" ? target.replica.context : target.context);
            return yield* RcMap.get(endpoints, new EndpointKey(ontology, target, context));
        }
        const target = single
            ? (options as OntologyBindingOptions<R>)
            : settings.resolve
              ? yield* settings.resolve(ontology)
              : yield* Effect.fail(
                    new BackendError({
                        operation: "ontology.route",
                        kind: "NotFound",
                        retryable: false,
                        message: "Unknown ontology.",
                    })
                );
        const context = target.authenticate
            ? yield* authenticateRequest(target.authenticate, request)
            : target.kind === "replica"
              ? target.replica.context
              : target.context;
        return yield* RcMap.get(endpoints, new EndpointKey(ontology, target, context));
    });
    const server: OntologyServer<R> = {
        _tag: "OntologyServer",
        defaultOntology: single ? "" : undefined,
        bind,
        invalidate,
        forget,
        partitions: Option.isSome(runtimes)
            ? Effect.flatMap(getCatalog, (catalog) => catalog.partitions)
            : Effect.succeed([]),
        syncOnce: (ontology, settings) =>
            Effect.scoped(
                Effect.gen(function* () {
                    const bound: OntologyRpcServerOptions<R> = (yield* bind(ontology)).options;
                    if (!bound.replica)
                        return yield* new BackendError({
                            operation: "server.syncOnce",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "Only replica routes support native synchronization checkpoints.",
                        });
                    yield* settings?.revalidate ? bound.replica.revalidate : bound.replica.syncOnce;
                    return { pins: yield* bound.replica.demand.pins.list };
                })
            ),
        // Failures before a route is bound: its IR policy is not known yet.
        errors: (error) =>
            forwardedStartupErrors.has(error) ? error : projectBackendError(error, "projected"),
        ir: settings.ir,
        upstreamErrors: settings.upstreamErrors,
    };
    // Preserve eager configuration validation for the single-ontology shorthand.
    if ("kind" in options && !options.authenticate) {
        const bound = yield* bind("");
        // Configuration is a binding, not a live reference to mutable app state.
        options = { ...options, context: bound.options.context } as OntologyBindingOptions<R>;
    }
    return server;
});

export interface MakeOntologyServer {
    <R = never, const Paths extends string = string>(
        options:
            | OntologyServerRoutes<R, Paths, Exclude<OpenedOntologyRoute<R>, ManagedReplicaRoute<R>>>
            | OntologyBindingOptions<R>
    ): Effect.Effect<OntologyServer<Exclude<R, Scope.Scope>>, BackendError, R | Scope.Scope>;
    <R = never, const Paths extends string = string>(
        options: OntologyServerRoutes<R, Paths>
    ): Effect.Effect<OntologyServer<Exclude<R, Scope.Scope>>, BackendError, R | Runtimes | Scope.Scope>;
}
export const makeOntologyServer: MakeOntologyServer = constructServer as MakeOntologyServer;

/** One RPC server dispatches all targets, including calls in the same HTTP batch. */
export const ontologyServerDispatch = <R = never>(router: OntologyServer<R>) => {
    type Handler = RpcGroup.HandlersFrom<Rpcs>[Rpcs["_tag"]];
    const handlers = Object.fromEntries(
        [...OntologyRpcs.requests].map(([tag, rpc]) => {
            const invoke = (payload: never, request: Parameters<Handler>[1]) =>
                Effect.gen(function* () {
                    const ontology =
                        request.headers[ontologyHeader] ?? (yield* OntologyTransportTarget) ?? "";
                    const existing = yield* OntologyTransportBinding;
                    const bound =
                        existing?.ontology === ontology
                            ? (existing.bound as BoundOntology<R>)
                            : yield* router.bind(ontology, yield* OntologyTransportRequest);
                    const handler = yield* OntologyRpcs.accessHandler(tag as Rpcs["_tag"]).pipe(
                        Effect.provideContext(bound.handlers)
                    );
                    const result = handler(payload, request) as
                        | Effect.Effect<unknown, BackendError, R>
                        | Stream.Stream<unknown, BackendError, R>;
                    const action = payload as { name?: string; invocation?: { name?: string } } | undefined;
                    const project = (error: BackendError) =>
                        projectBackendError(
                            error,
                            bound.options.errors,
                            errorContext(bound.options, action?.name ?? action?.invocation?.name)
                        );
                    return RpcSchema.isStreamSchema(rpc.successSchema)
                        ? (result as Stream.Stream<unknown, BackendError, R>).pipe(
                              Stream.mapError(project),
                              Stream.provideService(CurrentExecutionContext, bound.executionContext)
                          )
                        : (result as Effect.Effect<unknown, BackendError, R>).pipe(
                              Effect.mapError(project),
                              Effect.provideService(CurrentExecutionContext, bound.executionContext)
                          );
                }).pipe(Effect.mapError((error) => projectBackendError(error, router.errors)));
            return [
                tag,
                RpcSchema.isStreamSchema(rpc.successSchema)
                    ? (payload: never, request: Parameters<Handler>[1]) =>
                          Stream.unwrap(
                              invoke(payload, request).pipe(
                                  Effect.map((result) => result as Stream.Stream<unknown, BackendError, R>)
                              )
                          )
                    : (payload: never, request: Parameters<Handler>[1]) =>
                          Effect.scoped(
                              Effect.flatten(
                                  invoke(payload, request).pipe(
                                      Effect.map(
                                          (result) => result as Effect.Effect<unknown, BackendError, R>
                                      )
                                  )
                              )
                          ),
            ];
        })
    ) as unknown as {
        readonly [Procedure in Rpcs as Procedure["_tag"]]: Rpc.ToHandlerFn<Procedure, R | Scope.Scope>;
    };
    // Errors have already been projected for the selected ontology. Keep the
    // outer middleware for defect conversion without projecting them a second time.
    return Layer.merge(OntologyRpcs.toLayer(handlers), errorProjectionLayer({ errors: "forward" }));
};
