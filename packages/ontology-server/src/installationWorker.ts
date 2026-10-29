import { createConnectionMonitor, ConnectionError, type Connection } from "@party-stack/connect";
import { BackendError, classifyBackendFailure, unauthenticated } from "@party-stack/ontology-backend";
import { protocolValueCodec } from "@party-stack/ontology-backend/protocol";
import { replicaStateSource } from "@party-stack/ontology-replica";
import { TraceRecording } from "@party-stack/runtime/tracing";
import {
    Cause,
    Redacted,
    Deferred,
    Effect,
    Exit,
    Fiber,
    Layer,
    LayerMap,
    Queue,
    RcMap,
    Schema,
    Scope,
    Stream,
    Schedule,
} from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSchema, RpcServer } from "effect/rpc";
import { errorProjectionLayer } from "./errorProjection.js";
import { createConnectedLiveOntology } from "./liveClient.js";
import { makeOntologyProtocolClient, makeTracedRpcClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import type { makeOntologyRpcClient } from "./rpc.js";
import type {
    LiveOntology,
    OntologyBackendInstallation,
    OntologyBackendInstallationService,
    OntologyDefinition,
    LiveOntologyWrites,
} from "@party-stack/ontology";
import type { MetaOntology } from "@party-stack/ontology-spec/meta";
import type { RuntimeLayer, BrowserAuthentication } from "@party-stack/runtime";
import type { Worker, WorkerRunner } from "effect/workers";
import type { WorkerError } from "effect/workers/WorkerError";

const ConnectionSchema = Schema.Struct({
    userId: Schema.String,
    state: Schema.Union([
        Schema.Struct({ status: Schema.Literal("pending") }),
        Schema.Struct({
            status: Schema.Literal("active"),
            expiration: Schema.optional(
                Schema.Struct({ expiresAt: Schema.Number, refreshable: Schema.Boolean })
            ),
        }),
        Schema.Struct({ status: Schema.Literal("inactive") }),
        Schema.Struct({ status: Schema.Literal("needs-auth"), error: Schema.optional(Schema.String) }),
        Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
    ]),
});
const Value = protocolValueCodec(Schema.Unknown);
const Controls = RpcGroup.make(
    Rpc.make("InstallationDescribe", {
        success: Schema.Struct({
            installationId: Schema.String,
            oauthRedirectUrl: Schema.optional(Schema.NonEmptyString),
        }),
        error: BackendError,
    }),
    Rpc.make("ConnectionRecords", {
        success: Schema.Array(ConnectionSchema),
        stream: true,
        error: BackendError,
    }),
    Rpc.make("Authentication", {
        payload: { path: Schema.Array(Schema.NonEmptyString), args: Schema.Array(Value) },
        success: Value,
        error: BackendError,
    }),
    Rpc.make("ReportUnauthenticated", {
        payload: { userId: Schema.String, message: Schema.String },
        error: BackendError,
    }),
    Rpc.make("RefreshConnections", { error: BackendError }),
    Rpc.make("DisconnectConnection", { payload: { userId: Schema.String }, error: BackendError }),
    Rpc.make("ForgetConnection", { payload: { userId: Schema.String }, error: BackendError })
);
const InstallationRpcs = OntologyRpcs.merge(Controls);
const Selection = Schema.Struct({
    userId: Schema.NonEmptyString,
    ontologyId: Schema.NonEmptyString,
    meta: Schema.Boolean,
});
const SelectionCodec = Schema.fromJsonString(Selection);
const routeHeader = "x-party-stack-ontology";
const forbiddenPath = new Set(["__proto__", "prototype", "constructor", "then"]);

/** Trusted same-origin browser control plane. Never expose this authentication surface
 * as a public ontology endpoint: public servers use the authorized ontology protocol.
 * One installation owns credentials, sessions and all persistent ontology partitions.
 */
export const serveInstallationWorker = Effect.fn("OntologyInstallation.serveWorker")(function* <
    A extends object,
    R = never,
>(
    options: { readonly idleTimeToLive?: number; readonly traceRecording?: boolean } & (
        | { readonly installation: OntologyBackendInstallationService<A>; readonly open?: never }
        | {
              readonly open: Effect.Effect<
                  OntologyBackendInstallationService<A>,
                  BackendError,
                  R | Scope.Scope
              >;
              readonly installation?: never;
          }
    )
): Effect.fn.Return<
    Fiber.Fiber<never, WorkerError>,
    never,
    R | Scope.Scope | WorkerRunner.WorkerRunnerPlatform
> {
    const ready = yield* Deferred.make<OntologyBackendInstallationService<A>, BackendError>();
    const current = Deferred.await(ready);
    const startupScope = yield* Scope.fork(yield* Effect.scope);
    yield* Scope.provide(options.open ?? Effect.succeed(options.installation!), startupScope).pipe(
        Effect.provideService(TraceRecording, options.traceRecording === false ? false : "live"),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(startupScope, exit) : Effect.void)),
        Effect.flatMap((installation) => Deferred.succeed(ready, installation)),
        Effect.catchCause((cause) =>
            Deferred.fail(
                ready,
                Cause.hasDies(cause)
                    ? new BackendError({
                          operation: "installation.open",
                          kind: "Internal",
                          retryable: false,
                          message: "Installation startup failed.",
                          cause: Redacted.make(cause),
                      })
                    : classifyBackendFailure("installation.open", Cause.squash(cause))
            )
        ),
        Effect.forkScoped
    );
    const hosts = yield* LayerMap.make(
        (key: string) =>
            Layer.unwrap(
                Effect.gen(function* () {
                    const installation = yield* current;
                    const selection = yield* Schema.decodeUnknownEffect(SelectionCodec)(key).pipe(
                        Effect.mapError(
                            () =>
                                new BackendError({
                                    operation: "installation.route",
                                    kind: "InvalidRequest",
                                    retryable: false,
                                    message: "Invalid ontology selection.",
                                })
                        )
                    );
                    const live = yield* Effect.acquireRelease(
                        (selection.meta
                            ? installation.openMetaOntology(selection)
                            : installation.openOntology(selection)) as Effect.Effect<
                            LiveOntology,
                            BackendError
                        >,
                        (live) =>
                            (selection.meta
                                ? installation.closeMetaOntology({ ...selection, ifReplica: live.storage })
                                : installation.closeOntology({ ...selection, ifReplica: live.storage })
                            ).pipe(
                                Effect.catch((error) =>
                                    Effect.logError("Ontology host cleanup failed", error)
                                )
                            )
                    );
                    if (!live.storage)
                        return yield* new BackendError({
                            operation: "installation.open",
                            kind: "InvalidConfiguration",
                            retryable: false,
                            message: "An installation worker requires an ontology replica.",
                        });
                    return ontologyRpcHandlers({
                        ontology: live,
                        source: replicaStateSource(live.storage),
                        ir: live.ir,
                        context: live.context,
                        errors: "forward",
                        authorize: () => Effect.void,
                    });
                })
            ),
        { idleTimeToLive: options.idleTimeToLive ?? 60_000 }
    );
    type Rpcs = RpcGroup.Rpcs<typeof OntologyRpcs>;
    type Handler = RpcGroup.HandlersFrom<Rpcs>[Rpcs["_tag"]];
    const handlers = Object.fromEntries(
        [...OntologyRpcs.requests].map(([tag, rpc]) => {
            const invoke = (payload: never, request: Parameters<Handler>[1]) =>
                Effect.gen(function* () {
                    const key = request.headers[routeHeader];
                    if (!key)
                        return yield* new BackendError({
                            operation: "installation.route",
                            kind: "InvalidRequest",
                            retryable: false,
                            message: "An ontology selection is required.",
                        });
                    const context = yield* hosts.contextEffect(key);
                    const handler = yield* OntologyRpcs.accessHandler(tag as Rpcs["_tag"]).pipe(
                        Effect.provideContext(context)
                    );
                    return handler(payload, request) as
                        | Effect.Effect<unknown, BackendError>
                        | Stream.Stream<unknown, BackendError>;
                });
            // The retained LayerMap lease spans the complete RPC/stream, including byte transfers.
            return [
                tag,
                RpcSchema.isStreamSchema(rpc.successSchema)
                    ? (payload: never, request: Parameters<Handler>[1]) =>
                          Stream.unwrap(
                              invoke(payload, request).pipe(
                                  Effect.map((result) => result as Stream.Stream<unknown, BackendError>)
                              )
                          )
                    : (payload: never, request: Parameters<Handler>[1]) =>
                          Effect.scoped(
                              Effect.flatten(
                                  invoke(payload, request).pipe(
                                      Effect.map((result) => result as Effect.Effect<unknown, BackendError>)
                                  )
                              )
                          ),
            ];
        })
    ) as unknown as {
        readonly [Procedure in Rpcs as Procedure["_tag"]]: Rpc.ToHandlerFn<Procedure, Scope.Scope>;
    };
    const resetHosts = Effect.fnUntraced(function* (userId: string) {
        for (const key of yield* RcMap.keys(hosts.rcMap))
            if (Schema.decodeUnknownSync(SelectionCodec)(key).userId === userId) yield* hosts.invalidate(key);
    });
    const controls = Controls.toLayer({
        InstallationDescribe: () =>
            Effect.flatMap(current, (installation) =>
                Effect.sync(() => {
                    const redirect = Object.getOwnPropertyDescriptor(
                        installation.authentication,
                        "oauthRedirectUrl"
                    )?.value;
                    return {
                        installationId: installation.installationId,
                        oauthRedirectUrl: Schema.is(Schema.NonEmptyString)(redirect) ? redirect : undefined,
                    };
                })
            ),
        ReportUnauthenticated: ({ userId, message }) =>
            Effect.flatMap(current, (installation) =>
                installation
                    .connectionMonitor(userId)
                    .reportUnauthenticated(unauthenticated(message))
                    .pipe(
                        Effect.mapError((cause) =>
                            classifyBackendFailure("installation.authentication", cause)
                        )
                    )
            ),
        ConnectionRecords: () =>
            Stream.unwrap(Effect.map(current, (installation) => installation.connectionChanges)),
        RefreshConnections: () =>
            Effect.flatMap(current, (installation) => installation.refreshConnections()),
        DisconnectConnection: ({ userId }) =>
            resetHosts(userId).pipe(
                Effect.andThen(Effect.flatMap(current, (installation) => installation.disconnect(userId)))
            ),
        ForgetConnection: ({ userId }) =>
            resetHosts(userId).pipe(
                Effect.andThen(Effect.flatMap(current, (installation) => installation.forget(userId)))
            ),
        Authentication: ({ path, args }) =>
            Effect.flatMap(current, (installation) =>
                Effect.tryPromise({
                    try: async () => {
                        if (!path.length || path.length > 6 || path.some((part) => forbiddenPath.has(part)))
                            throw new BackendError({
                                operation: "installation.authentication",
                                kind: "InvalidRequest",
                                retryable: false,
                                message: "Invalid authentication operation.",
                            });
                        let parent: unknown = installation.authentication;
                        for (const part of path.slice(0, -1)) parent = Reflect.get(Object(parent), part);
                        const method = Reflect.get(Object(parent), path[path.length - 1]!);
                        if (typeof method !== "function")
                            throw new BackendError({
                                operation: "installation.authentication",
                                kind: "InvalidRequest",
                                retryable: false,
                                message: "Unknown authentication operation.",
                            });
                        return await Reflect.apply(method, parent, args);
                    },
                    catch: (cause) => classifyBackendFailure("installation.authentication", cause),
                })
            ),
    });
    return yield* RpcServer.make(InstallationRpcs).pipe(
        Effect.provide(Layer.merge(OntologyRpcs.toLayer(handlers), controls)),
        Effect.provide(errorProjectionLayer({ errors: "forward" })),
        Effect.provide(RpcServer.layerProtocolWorkerRunner),
        Effect.forkScoped({ startImmediately: true })
    );
});

/** Promise authentication clients are a UI boundary; the worker owns every private record. */
const remoteAuthentication = <A extends object>(
    call: (path: readonly string[], args: readonly unknown[]) => Promise<unknown>,
    path: readonly string[] = []
): A =>
    new Proxy(() => undefined, {
        get: (_target, property) =>
            property === "then" || typeof property !== "string"
                ? undefined
                : remoteAuthentication(call, [...path, property]),
        apply: (_target, _this, args) => call(path, args),
    }) as A;

/** One RPC transport carries installation controls and every selected ontology.
 * The page's replicas use the supplied memory Runtime Layer, never the owner's tables.
 */
export const connectInstallationWorker = Effect.fn("OntologyInstallation.connectWorker")(function* <
    A extends object = object,
>(options: {
    readonly runtime: RuntimeLayer;
    readonly browserAuthentication?: BrowserAuthentication;
    readonly writes?: LiveOntologyWrites;
    readonly connectionTimeoutMs?: number;
    /** SharedWorker devtools recording is enabled by default; no platform Runtime dependency. */
    readonly traceRecording?: boolean;
}): Effect.fn.Return<
    OntologyBackendInstallation<A>,
    BackendError,
    Scope.Scope | Worker.WorkerPlatform | Worker.Spawner
> {
    const owner = yield* Scope.fork(yield* Effect.scope);
    const open = Effect.gen(function* () {
        const transport = yield* Layer.build(
            RpcClient.layerProtocolWorker({ size: 1, concurrency: 64 })
        ).pipe(Effect.mapError((cause) => classifyBackendFailure("installation.connect", cause)));
        const rpc = yield* makeTracedRpcClient(InstallationRpcs).pipe(Effect.provideContext(transport));
        const runWith = Effect.runPromiseWith(yield* Effect.context<never>());
        const run = <B, E>(effect: Effect.Effect<B, E>) =>
            runWith(
                Effect.acquireUseRelease(
                    Effect.forkIn(effect, owner, { startImmediately: true }),
                    Fiber.join,
                    Fiber.interrupt
                )
            );
        const description = yield* rpc
            .InstallationDescribe()
            .pipe(Effect.mapError((cause) => classifyBackendFailure("installation.describe", cause)));
        const connections = new Map<string, Connection>();
        const listeners = new Map<string, Set<(state: Connection["state"]) => void>>();
        const initial = yield* Deferred.make<void, BackendError>();
        const events = new Set<(rows: readonly Connection[]) => void>();
        const install = Effect.fnUntraced(function* (rows: readonly Connection[]) {
            const previous = new Map(connections);
            connections.clear();
            for (const row of rows) connections.set(row.userId, row);
            for (const id of new Set([...previous.keys(), ...connections.keys()])) {
                const state = connections.get(id)?.state ?? { status: "inactive" as const };
                if (JSON.stringify(previous.get(id)?.state) !== JSON.stringify(state))
                    for (const listener of listeners.get(id) ?? [])
                        yield* Effect.try({ try: () => listener(state), catch: () => undefined }).pipe(
                            Effect.catch(() => Effect.logWarning("Connection subscriber failed"))
                        );
            }
            for (const emit of events) emit(rows);
            yield* Deferred.succeed(initial, undefined);
        });
        yield* Stream.runForEach(rpc.ConnectionRecords(), install).pipe(
            Effect.mapError((cause) => classifyBackendFailure("installation.connections", cause)),
            Effect.retry({ schedule: Schedule.spaced(1000), while: (error) => error.retryable }),
            Effect.catch((cause) =>
                Deferred.fail(initial, classifyBackendFailure("installation.connections", cause)).pipe(
                    Effect.andThen(Effect.logError("Installation connection stream failed", cause))
                )
            ),
            Effect.forkScoped
        );
        yield* Deferred.await(initial);
        const authentication = new Proxy(
            remoteAuthentication<A>((path, args) => run(rpc.Authentication({ path, args }))),
            {
                get: (target, key) =>
                    key === "oauthRedirectUrl" ? description.oauthRedirectUrl : Reflect.get(target, key),
            }
        );
        if (options.browserAuthentication && description.oauthRedirectUrl) {
            const browser = options.browserAuthentication;
            const remote = authentication as {
                beginOAuth?: () => Promise<{ authorizationUrl: string; redirectUrl: string }>;
                completeOAuthRedirect?: (url: string) => Promise<unknown>;
            };
            // Browser-only presentation. PKCE, token exchange and credential persistence stay in the owner.
            const oauth = (settings?: { browserPresentation?: "popup" | "redirect" }) =>
                run(
                    Effect.scoped(
                        Effect.gen(function* () {
                            // Reservation happens in this click task, before the first RPC await.
                            const presentation = yield* browser.start({
                                redirectUrl: description.oauthRedirectUrl!,
                                presentation: settings?.browserPresentation,
                            });
                            const started = yield* Effect.tryPromise({
                                try: () => remote.beginOAuth!(),
                                catch: (cause) => classifyBackendFailure("authentication.begin", cause),
                            });
                            if (started.redirectUrl !== description.oauthRedirectUrl)
                                return yield* new BackendError({
                                    operation: "installation.authentication",
                                    kind: "InvalidResponse",
                                    retryable: false,
                                    message: "OAuth redirect configuration changed.",
                                });
                            const completed = yield* presentation.open(started.authorizationUrl);
                            return yield* Effect.tryPromise({
                                try: () => remote.completeOAuthRedirect!(completed.callbackUrl),
                                catch: (cause) => classifyBackendFailure("authentication.complete", cause),
                            });
                        })
                    )
                );
            // Only the interactive leaf is local. Every other authentication method is RPC.
            const original = authentication as { signIn: object };
            const signIn = new Proxy(original.signIn, {
                get: (target, key) => (key === "oauth" ? oauth : Reflect.get(target, key)),
            });
            const delegated = new Proxy(authentication, {
                get: (target, key) => (key === "signIn" ? signIn : Reflect.get(target, key)),
            });
            return yield* finish(delegated);
        }
        return yield* finish(authentication);

        function finish(authentication: A) {
            return Effect.gen(function* () {
                const views = new Map<string, Promise<LiveOntology>>();
                const openView = <T extends OntologyDefinition>(
                    selection: typeof Selection.Type
                ): Promise<LiveOntology<T>> => {
                    const key = Schema.encodeSync(SelectionCodec)(selection);
                    let view = views.get(key);
                    if (!view) {
                        // Routing headers are bound on each operation, including subscriptions.
                        const routed = Object.fromEntries(
                            [...OntologyRpcs.requests.keys()].map((tag) => [
                                tag,
                                (payload: unknown, settings?: object) =>
                                    Reflect.apply(Reflect.get(rpc, tag), rpc, [
                                        payload,
                                        { ...settings, headers: { [routeHeader]: key } },
                                    ]),
                            ])
                        ) as Effect.Success<typeof makeOntologyRpcClient>;
                        view = createConnectedLiveOntology({
                            id: `${description.installationId}:${selection.ontologyId}${selection.meta ? ":meta" : ""}`,
                            connection: makeOntologyProtocolClient(routed),
                            runtime: options.runtime,
                            writes: options.writes,
                            label: "This tab",
                            traceRecording: options.traceRecording === false ? false : "buffer",
                            parent: { label: "Host", location: "Shared worker" },
                        });
                        views.set(key, view);
                        void view.catch(() => {
                            if (views.get(key) === view) views.delete(key);
                        });
                    }
                    return view as Promise<LiveOntology<T>>;
                };
                const closeView = async (selection: typeof Selection.Type) => {
                    const key = Schema.encodeSync(SelectionCodec)(selection);
                    const view = views.get(key);
                    views.delete(key);
                    if (view) await (await view).cleanup();
                };
                const closeUser = async (userId: string) => {
                    for (const key of views.keys()) {
                        const selection = Schema.decodeUnknownSync(SelectionCodec)(key);
                        if (selection.userId === userId) await closeView(selection);
                    }
                };
                yield* Effect.addFinalizer(() =>
                    Effect.promise(async () => {
                        await Promise.all([...views.values()].map(async (view) => (await view).cleanup()));
                        views.clear();
                        listeners.clear();
                        events.clear();
                        connections.clear();
                    })
                );
                return {
                    installationId: description.installationId,
                    authentication,
                    connections,
                    connectionChanges: Stream.callback<readonly Connection[]>(
                        (queue) =>
                            Effect.acquireRelease(
                                Effect.sync(() => {
                                    const emit = (rows: readonly Connection[]) => {
                                        Queue.offerUnsafe(queue, rows);
                                    };
                                    events.add(emit);
                                    emit([...connections.values()]);
                                    return emit;
                                }),
                                (emit) =>
                                    Effect.sync(() => {
                                        events.delete(emit);
                                    })
                            ),
                        { bufferSize: 1, strategy: "sliding" }
                    ),
                    refreshConnections: () => run(rpc.RefreshConnections()),
                    connectionMonitor: (userId: string) =>
                        createConnectionMonitor(
                            {
                                connections,
                                subscribeConnection: (id, listener) => {
                                    let set = listeners.get(id);
                                    if (!set) listeners.set(id, (set = new Set()));
                                    set.add(listener);
                                    return () => {
                                        set.delete(listener);
                                        if (!set.size) listeners.delete(id);
                                    };
                                },
                                reportUnauthenticated: (_id, error) =>
                                    rpc
                                        .ReportUnauthenticated({ userId, message: error.message })
                                        .pipe(
                                            Effect.mapError((cause) =>
                                                ConnectionError.from("authentication", cause)
                                            )
                                        ),
                            },
                            userId
                        ),
                    openOntology: <T extends OntologyDefinition>(selection: {
                        userId: string;
                        ontologyId: string;
                    }) => openView<T>({ ...selection, meta: false }),
                    openMetaOntology: (selection: { userId: string; ontologyId: string }) =>
                        openView<MetaOntology>({
                            ...selection,
                            meta: true,
                        }),
                    closeOntology: (selection: { userId: string; ontologyId: string }) =>
                        closeView({ ...selection, meta: false }),
                    closeMetaOntology: (selection: { userId: string; ontologyId: string }) =>
                        closeView({ ...selection, meta: true }),
                    disconnect: async (userId: string) => {
                        await closeUser(userId);
                        await run(rpc.DisconnectConnection({ userId }));
                    },
                    forget: async (userId: string) => {
                        await closeUser(userId);
                        await run(rpc.ForgetConnection({ userId }));
                    },
                    cleanup: () => Effect.runPromise(Scope.close(owner, Exit.void)),
                } satisfies OntologyBackendInstallation<A>;
            });
        }
    });
    return yield* Scope.provide(open, owner).pipe(
        Effect.timeoutOrElse({
            duration: options.connectionTimeoutMs ?? 20_000,
            orElse: () =>
                Effect.fail(
                    new BackendError({
                        operation: "installation.connect",
                        kind: "Unavailable",
                        retryable: true,
                        message: "Installation worker handshake timed out.",
                    })
                ),
        }),
        Effect.mapError((cause) => classifyBackendFailure("installation.connect", cause)),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(owner, exit) : Effect.void))
    );
});
