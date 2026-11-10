import { BackendError, classifyBackendFailure, isUnauthenticatedError } from "@party-stack/ontology-backend";
import * as q from "@party-stack/ontology-spec/query";
import { Clock, Context, Effect, Fiber, Queue, RcMap, Schema, Stream, Schedule, Semaphore } from "effect";
import { connectionAccessToken } from "./core/accessToken.js";
import { connectBackendError } from "./core/backend.js";
import { connectError } from "./core/errors.js";
import { createDefaultConnectionEgressHandlers } from "./createDefaultConnectionEgressHandlers.js";
import { connectOntology } from "./spec/index.js";
import type { ConnectStore } from "./core/store.js";
import type { ConnectionRef, SavedConnection, ServiceConnector } from "./ServiceConnector.js";
import type { ConnectOntology, ServiceInstanceRecord } from "./spec/index.js";
import type {
    ConnectionEgress,
    ConnectionEgressHandlers,
    ConnectionMonitor,
    ConnectionState,
} from "./types.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

/** Scoped identity and egress for one saved connection. Cached data can reopen
 * while authentication is required; actual egress always requires active credentials.
 */
export interface ConnectionAccess {
    readonly connection: ConnectionRef;
    readonly userId: string;
    readonly serviceInstance: ServiceInstanceRecord;
    readonly egress: ConnectionEgress;
    readonly authentication: ConnectionMonitor;
}

const unavailable = (message: string) =>
    new BackendError({
        operation: "connect.acquire",
        kind: "Unauthenticated",
        retryable: false,
        message,
    });

// Observe the credential actually used by this request, including renewal. A
// later rejection must not change the status of a newer saved session.
const CredentialObserver = Context.Reference<(version: string) => void>(
    "@party-stack/connect/CredentialObserver",
    { defaultValue: () => () => {} }
);

/** Acquire saved identity and egress from ontology records. The map holds only
 * scoped access; the Connect backend remains the sole durable inventory.
 */
export const makeServiceConnections = Effect.fn("Connect.connections")(function* (options: {
    readonly backend: OntologyBackendService;
    readonly store: ConnectStore;
    readonly services: readonly ServiceConnector[];
    readonly handlers?: ConnectionEgressHandlers;
}) {
    const backend = options.backend;
    const services = new Map(options.services.map((service) => [service.service, service]));
    if (services.size !== options.services.length)
        return yield* new BackendError({
            operation: "connect.configure",
            kind: "InvalidConfiguration",
            retryable: false,
            message: "Service connector names must be unique.",
        });
    const read = Effect.fnUntraced(function* <N extends keyof ConnectOntology["objectTypes"]>(
        objectType: N,
        id: string
    ) {
        const rows = yield* backend.query({
            select: [
                q.sub("rows", {
                    from: { source: { objectType }, binding: "row" },
                    where: q.eq(q.field("row", "id"), q.literal(id)),
                    select: connectOntology.objectTypes
                        .find((type) => type.name === objectType)!
                        .properties.map((property) =>
                            q.selectField(property.name, q.field("row", property.name))
                        ),
                }),
            ],
        });
        return (rows.rows as ConnectOntology["objectTypes"][N][])[0];
    });
    const reference = Schema.Struct({
        objectType: Schema.Literals(["OAuthConnection", "ApiKeyConnection", "ExternalSessionConnection"]),
        id: Schema.NonEmptyString,
    });
    const codec = Schema.fromJsonString(reference);
    const access = yield* RcMap.make({
        lookup: Effect.fnUntraced(function* (key: string) {
            const ref = yield* Schema.decodeUnknownEffect(codec)(key).pipe(
                Effect.mapError((cause) => classifyBackendFailure("connect.acquire", cause))
            );
            const row = yield* read(ref.objectType, ref.id);
            if (!row || row.status === "inactive" || !row.userId)
                return yield* unavailable("The selected connection is disconnected.");
            const instanceId =
                ref.objectType === "OAuthConnection"
                    ? (yield* read(
                          "OAuthApplication",
                          (row as ConnectOntology["objectTypes"]["OAuthConnection"]).application
                      ))?.serviceInstance
                    : (
                          row as
                              | ConnectOntology["objectTypes"]["ApiKeyConnection"]
                              | ConnectOntology["objectTypes"]["ExternalSessionConnection"]
                      ).serviceInstance;
            const serviceInstance = instanceId ? yield* read("ServiceInstance", instanceId) : undefined;
            if (!serviceInstance)
                return yield* new BackendError({
                    operation: "connect.acquire",
                    kind: "NotFound",
                    retryable: false,
                    message: "Service instance is unavailable.",
                });
            const service = services.get(serviceInstance.service);
            if (!service)
                return yield* new BackendError({
                    operation: "connect.acquire",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "Service connector is unavailable.",
                });
            const sessionVerification = yield* Semaphore.make(1);
            const currentCredential = Effect.fnUntraced(function* (): Effect.fn.Return<string, BackendError> {
                const current = yield* read(ref.objectType, ref.id);
                if (!current || current.status === "inactive")
                    return yield* unavailable("The selected connection is disconnected.");
                if (current.status !== "active")
                    return yield* unavailable("The selected connection requires authentication.");
                if (ref.objectType === "OAuthConnection")
                    return yield* connectionAccessToken(backend, ref.id);
                const expiresAt = (
                    current as
                        | ConnectOntology["objectTypes"]["ExternalSessionConnection"]
                        | ConnectOntology["objectTypes"]["ApiKeyConnection"]
                ).expiresAt;
                if (ref.objectType === "ExternalSessionConnection") {
                    (yield* CredentialObserver)(credentialVersion(current));
                    if (expiresAt && expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis)) {
                        yield* sessionVerification
                            .withPermit(
                                Effect.gen(function* () {
                                    const selected = yield* options.store.get(
                                        "ExternalSessionConnection",
                                        ref.id
                                    );
                                    if (
                                        !selected ||
                                        selected.status !== "active" ||
                                        !selected.expiresAt ||
                                        selected.expiresAt.epochMilliseconds >
                                            (yield* Clock.currentTimeMillis)
                                    )
                                        return;
                                    if (!service.externalSession)
                                        return yield* new BackendError({
                                            operation: "connect.session.verify",
                                            kind: "InvalidConfiguration",
                                            retryable: false,
                                            message: "This service cannot verify an external session.",
                                        });
                                    (yield* CredentialObserver)(credentialVersion(selected));
                                    const verified = yield* Effect.result(
                                        service.externalSession({
                                            serviceInstance,
                                            sessionId: selected.sessionId,
                                        })
                                    );
                                    yield* options.store.transaction(
                                        Effect.gen(function* () {
                                            const latest = yield* options.store.get(
                                                "ExternalSessionConnection",
                                                ref.id
                                            );
                                            if (
                                                !latest ||
                                                credentialVersion(latest) !== credentialVersion(selected)
                                            )
                                                return;
                                            if (verified._tag === "Failure") return yield* verified.failure;
                                            const identity = verified.success;
                                            if (
                                                identity.userId !== selected.userId ||
                                                (identity.expiresAt &&
                                                    identity.expiresAt.epochMilliseconds <=
                                                        (yield* Clock.currentTimeMillis))
                                            )
                                                return yield* connectError(
                                                    "NeedsAuthentication",
                                                    "The selected external session requires authentication."
                                                );
                                            yield* options.store.put("ExternalSessionConnection", {
                                                ...latest,
                                                title: identity.title ?? latest.title,
                                                expiresAt: identity.expiresAt,
                                            });
                                        })
                                    );
                                })
                            )
                            .pipe(
                                Effect.mapError((error) =>
                                    error instanceof BackendError ? error : connectBackendError(error)
                                )
                            );
                        return yield* currentCredential();
                    }
                    return (current as ConnectOntology["objectTypes"]["ExternalSessionConnection"]).sessionId;
                }
                if (expiresAt && expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis))
                    return yield* unavailable("The selected connection has expired.");
                const apiKey = (current as ConnectOntology["objectTypes"]["ApiKeyConnection"]).apiKey;
                if (!apiKey || !backend.encrypted) return yield* unavailable("API key is unavailable.");
                const result = yield* backend.encrypted.decrypt({
                    ...apiKey,
                    source: { objectType: ref.objectType, primaryKey: ref.id, property: "apiKey" },
                });
                return yield* Schema.decodeUnknownEffect(Schema.String)(result.value).pipe(
                    Effect.mapError((cause) => classifyBackendFailure("connect.credential", cause))
                );
            });
            let state: ConnectionState = { status: row.status };
            let fingerprint = JSON.stringify(row);
            const credentialVersion = (value: typeof row | undefined) =>
                JSON.stringify(
                    !value
                        ? null
                        : [
                              value.status,
                              value.userId,
                              "application" in value
                                  ? [
                                        value.application,
                                        value.accessToken?.ciphertext,
                                        value.refreshToken?.ciphertext,
                                        value.operationId,
                                    ]
                                  : "sessionId" in value
                                    ? [value.serviceInstance, value.sessionId, value.expiresAt]
                                    : [value.serviceInstance, value.apiKey?.ciphertext, value.expiresAt],
                          ]
                );
            const listeners = new Set<(state: ConnectionState) => void>();
            const publish = (value: ConnectionState, changedCredential = false) => {
                if (!changedCredential && JSON.stringify(state) === JSON.stringify(value)) return;
                state = value;
                for (const listener of listeners) listener(value);
            };
            const install = (value: typeof row | undefined) => {
                const next = JSON.stringify(value);
                const changed = fingerprint !== next;
                fingerprint = next;
                if (changed || state.status === "error")
                    publish({ status: value?.status ?? "inactive" }, changed);
            };
            const watch =
                backend.changes?.watch ??
                backend.watchSubset?.({
                    from: { source: { objectType: ref.objectType }, binding: "connection" },
                    where: q.eq(q.field("connection", "id"), q.literal(ref.id)),
                });
            if (watch)
                yield* Stream.runForEach(
                    Stream.unwrap(
                        watch.pipe(
                            // Acquisition has registered and buffered the feed. Re-read
                            // after every acquisition, including a retry, before consuming hints.
                            Effect.tap(() =>
                                read(ref.objectType, ref.id).pipe(
                                    Effect.tap((value) => Effect.sync(() => install(value)))
                                )
                            )
                        )
                    ),
                    () =>
                        read(ref.objectType, ref.id).pipe(
                            Effect.tap((value) => Effect.sync(() => install(value)))
                        )
                ).pipe(
                    Effect.scoped,
                    Effect.tapError((error) =>
                        Effect.sync(() => publish({ status: "error", error: error.message }))
                    ),
                    Effect.retry({ schedule: Schedule.spaced(1000), while: (error) => error.retryable }),
                    Effect.catch((error) => Effect.logError("Connection watch stopped", error)),
                    Effect.forkScoped({ startImmediately: true })
                );
            // Supply a current value while background watch acquisition is pending;
            // the acquisition path repeats this read after registration.
            yield* read(ref.objectType, ref.id).pipe(
                Effect.tap((value) => Effect.sync(() => install(value)))
            );
            const authentication: ConnectionMonitor = {
                get state() {
                    return state;
                },
                changes: Stream.callback<ConnectionState>(
                    (queue) =>
                        Effect.acquireRelease(
                            Effect.sync(() => {
                                const send = (next: ConnectionState) => {
                                    Queue.offerUnsafe(queue, next);
                                };
                                listeners.add(send);
                                send(state);
                                return send;
                            }),
                            (send) =>
                                Effect.sync(() => {
                                    listeners.delete(send);
                                })
                        ),
                    { bufferSize: 1, strategy: "sliding" }
                ),
            };
            const handlers = options.handlers ?? createDefaultConnectionEgressHandlers();
            const sockets = new Set<WebSocket>();
            const lifetime = new AbortController();
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    listeners.clear();
                    lifetime.abort();
                    for (const socket of sockets) socket.close();
                    sockets.clear();
                })
            );
            const refresh = yield* Semaphore.make(1);
            const refreshCredential = (rejected: string) =>
                refresh.withPermit(
                    Effect.gen(function* () {
                        const current = yield* currentCredential();
                        if (current !== rejected) return current;
                        if (ref.objectType !== "OAuthConnection")
                            return yield* unavailable("This connection requires authentication.");
                        yield* backend.applyAction({
                            id: crypto.randomUUID(),
                            name: "refreshConnection",
                            parameters: { connectionId: ref.id },
                        });
                        return yield* currentCredential();
                    })
                );
            const acquired = yield* service.acquire({
                connection: { objectType: ref.objectType, value: row } as SavedConnection,
                serviceInstance,
                credential: currentCredential(),
                refreshCredential,
                handlers: {
                    fetch: (request) =>
                        handlers.fetch(
                            new Request(request, {
                                signal: AbortSignal.any([request.signal, lifetime.signal]),
                            })
                        ),
                    createWebSocket: Effect.fnUntraced(function* (
                        url: string | URL,
                        protocols?: string | string[]
                    ) {
                        const socket = yield* handlers.createWebSocket(url, protocols);
                        if (lifetime.signal.aborted) {
                            socket.close();
                            return yield* unavailable("The selected connection was released.");
                        }
                        sockets.add(socket);
                        socket.addEventListener("close", () => sockets.delete(socket), { once: true });
                        return socket;
                    }),
                },
            });
            const scope = yield* Effect.scope;
            const owned = <A>(work: Effect.Effect<A, BackendError>) =>
                Effect.suspend(() =>
                    scope.state._tag === "Closed"
                        ? Effect.fail(unavailable("The selected connection was released."))
                        : Effect.acquireUseRelease(Effect.forkIn(work, scope), Fiber.join, Fiber.interrupt)
                );
            const failed = Effect.fnUntraced(function* (error: BackendError, observed: string | undefined) {
                if (isUnauthenticatedError(error)) {
                    // Compare and persist in one transaction: a late rejection must
                    // neither pause a newer login nor resurrect a disconnected row.
                    // The ordinary journal/watch path also updates account queries.
                    yield* options.store
                        .transaction(
                            Effect.gen(function* () {
                                const current = yield* options.store.get(ref.objectType, ref.id);
                                if (current?.status === "active" && credentialVersion(current) === observed) {
                                    yield* options.store.put(ref.objectType, {
                                        ...current,
                                        status: "needs-auth",
                                    });
                                }
                            })
                        )
                        .pipe(
                            Effect.mapError(connectBackendError),
                            Effect.tapError((cause) =>
                                Effect.logError("Could not save connection authentication status", cause)
                            ),
                            Effect.ignore,
                            Effect.uninterruptible
                        );
                }
                return yield* error;
            });
            const requireAuthentication = Effect.fnUntraced(function* () {
                const current = yield* read(ref.objectType, ref.id);
                if (!current || current.status === "inactive")
                    return yield* unavailable("The selected connection is disconnected.");
                if (current.status !== "active")
                    return yield* unavailable("The selected connection requires authentication.");
                return current;
            });
            const egress: ConnectionEgress = {
                fetch: (input, init) =>
                    owned(
                        Effect.gen(function* () {
                            let observed = credentialVersion(yield* requireAuthentication());
                            const request = yield* Effect.try({
                                try: () => new Request(input, init),
                                catch: (cause) => classifyBackendFailure("connect.egress.fetch", cause),
                            });
                            return yield* acquired.fetch(request).pipe(
                                Effect.provideService(CredentialObserver, (value) => {
                                    observed = value;
                                }),
                                Effect.catch((error) => failed(error, observed))
                            );
                        })
                    ),
                createWebSocket: (url, protocols) =>
                    owned(
                        Effect.gen(function* () {
                            let observed = credentialVersion(yield* requireAuthentication());
                            return yield* acquired.createWebSocket(url, protocols).pipe(
                                Effect.provideService(CredentialObserver, (value) => {
                                    observed = value;
                                }),
                                Effect.catch((error) => failed(error, observed))
                            );
                        })
                    ),
            };
            return {
                connection: ref,
                userId: row.userId,
                serviceInstance: serviceInstance as ServiceInstanceRecord,
                egress,
                authentication,
            } satisfies ConnectionAccess;
        }),
    });
    return {
        acquire: (connection: ConnectionRef) => RcMap.get(access, Schema.encodeSync(codec)(connection)),
    };
});
