import { makeConnectionManager, createConnectionMonitor } from "@party-stack/connect";
import { BackendError } from "@party-stack/ontology-backend";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { eq, field } from "@party-stack/ontology-storage";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime } from "@party-stack/runtime";
import { Context, Effect, Exit, Fiber, Layer, RcMap, Scope, ScopedCache, Semaphore } from "effect";
import { makeLiveOntology } from "../live/LiveOntology.js";
import { createMetaOntologyConfiguration } from "./createMetaOntologyConfiguration.js";
import type { LiveOntology, OntologyDefinition } from "../live/LiveOntology.js";
import type {
    CreateOntologyBackendInstallationOptions,
    OntologyBackendInstallation,
    OntologyBackendInstallationService,
    OntologyRoute,
} from "./types.js";
import type { Connection } from "@party-stack/connect";
import type { MetaOntology } from "@party-stack/ontology-spec/meta";

interface LocalOntologyPartition {
    owner?: string;
    id: string;
    userId: string;
    ontologyId: string;
    meta?: true;
}

function scope(value: string): string {
    return encodeURIComponent(value);
}

function liveOntologyNamespace(installationId: string, ontologyId: string): string {
    return `${scope(installationId)}:${scope(ontologyId)}`;
}

function isActiveConnection(connection: Connection | undefined): connection is Connection<"active"> {
    return connection?.state.status === "active";
}

function routeFor(routes: readonly OntologyRoute[], ontologyId: string): OntologyRoute {
    const matching = routes.filter((route) => route.matches(ontologyId));
    if (matching.length !== 1) {
        throw new BackendError({
            operation: "installation.route",
            kind: "InvalidConfiguration",
            retryable: false,
            message:
                matching.length === 0
                    ? `No ontology route matched "${ontologyId}".`
                    : `Multiple ontology routes matched "${ontologyId}".`,
        });
    }
    return matching[0]!;
}

const failure = (operation: string, cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation,
              kind: "Unavailable",
              message: cause instanceof Error ? cause.message : "Installation operation failed.",
              retryable: true,
              cause,
          });
const boundary = <A>(operation: string, run: () => PromiseLike<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) });

export class OntologyInstallation extends Context.Service<
    OntologyInstallation,
    OntologyBackendInstallationService
>()("@party-stack/ontology/OntologyInstallation") {
    static readonly layer = (options: CreateOntologyBackendInstallationOptions) =>
        Layer.effect(OntologyInstallation, makeOntologyBackendInstallation(options));
}

/** Native lifecycle: collections, sessions, live ontologies and in-flight opens share one scope. */
export const makeOntologyBackendInstallation = Effect.fn("OntologyInstallation.make")(function* <
    A extends object = object,
>(
    options: CreateOntologyBackendInstallationOptions<A>
): Effect.fn.Return<OntologyBackendInstallationService<A>, BackendError, Scope.Scope> {
    const owner = yield* Effect.scope;
    const runtime = yield* options
        .runtime("installation", scope(options.installationId))
        .pipe(Effect.mapError((cause) => failure("installation.runtime", cause)));
    return yield* Effect.gen(function* () {
        const connectionManager = yield* makeConnectionManager({
            installationId: options.installationId,
            adapter: options.connections,
        }).pipe(Effect.mapError((cause) => failure("installation.connections", cause)));
        const partitions = Table.make<LocalOntologyPartition>({
            name: JSON.stringify([
                "local",
                runtime.adapter.owner,
                runtime.adapter.namespace,
                "ontology-partitions",
            ]),
            version: 1,
        });
        yield* runtime.tables
            .ensureIndex(partitions, { name: "userId", field: field("userId") })
            .pipe(Effect.mapError((cause) => failure("installation.restore", cause)));
        let disposed = false;
        const closed = () =>
            new BackendError({
                operation: "installation.closed",
                kind: "InvalidRequest",
                retryable: false,
                message: `Backend installation "${options.installationId}" is closed.`,
            });
        const ensureOpen = Effect.suspend(() => (disposed ? Effect.fail(closed()) : Effect.void));
        const locks = yield* RcMap.make({ lookup: () => Semaphore.make(1) });
        const locked = <B, E, R>(userId: string, work: Effect.Effect<B, E, R>) =>
            Effect.scoped(Effect.flatMap(RcMap.get(locks, userId), (lock) => lock.withPermit(work)));
        const owned = <B>(work: Effect.Effect<B, BackendError>) =>
            Effect.andThen(ensureOpen, Effect.flatMap(Effect.forkIn(work, owner), Fiber.join));
        const recordPartition = (row: LocalOntologyPartition) =>
            runtime.tables
                .put(partitions, row.id, row)
                .pipe(Effect.mapError((cause) => failure("installation.partition", cause)));
        const cache = yield* ScopedCache.makeWith<string, LiveOntology, BackendError>({
            capacity: Number.MAX_SAFE_INTEGER,
            // Failed acquisitions must be retryable; successful resources live until explicit close or scope closure.
            timeToLive: (exit) => (Exit.isSuccess(exit) ? Infinity : 0),
            lookup: Effect.fn("OntologyInstallation.open")(function* (key: string) {
                const [userId, ontologyId, meta] = JSON.parse(key) as [string, string, boolean];
                const current = connectionManager.connections.get(userId);
                const egress = connectionManager.egress(userId);
                if (!isActiveConnection(current) || !egress)
                    return yield* new BackendError({
                        operation: "installation.open",
                        kind: "Unauthenticated",
                        retryable: false,
                        message: `User "${userId}" is not connected to backend installation "${options.installationId}".`,
                    });
                const route = yield* Effect.try({
                    try: () => routeFor(options.routes, ontologyId),
                    catch: (cause) => failure("installation.route", cause),
                });
                const configureOptions = { connection: current, egress, ontologyId };
                const configured = yield* boundary("installation.configure", async () => {
                    if (meta && route.configureMeta) return route.configureMeta(configureOptions);
                    if (route.configure) {
                        const application = await route.configure(configureOptions);
                        return meta ? createMetaOntologyConfiguration({ ir: application.ir }) : application;
                    }
                    throw new BackendError({
                        operation: "installation.route",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message: `Ontology route for "${ontologyId}" does not support ${meta ? "metadata" : "opening the application ontology"}.`,
                    });
                });
                const boundContext = {
                    ...options.createContext?.(userId, ontologyId),
                    ...configured.context,
                    user: userId,
                };
                const partitionOwner = yield* Effect.try({
                    try: () => contextPartition(configured.ir, boundContext),
                    catch: (cause) => failure("installation.partition", cause),
                });
                const partition = {
                    owner: partitionOwner,
                    id: JSON.stringify([userId, ontologyId, meta, partitionOwner]),
                    userId,
                    ontologyId,
                    meta: meta ? (true as const) : undefined,
                };
                yield* recordPartition(partition);
                const settings = {
                    installationId: options.installationId,
                    userId,
                    ontologyId,
                    id: `${liveOntologyNamespace(options.installationId, ontologyId)}${meta ? ":meta" : ""}`,
                    ir: configured.ir,
                    backend: configured.backend,
                    runtime: options.runtime,
                    context: boundContext,
                    persistObjects: configured.persistObjects,
                    writes: configured.writes,
                    connection: createConnectionMonitor(connectionManager, userId),
                };
                if (!meta && options.openOntology)
                    return yield* Effect.acquireRelease(
                        boundary("installation.open", () => options.openOntology!(settings)),
                        (ontology) => Effect.promise(() => ontology.cleanup())
                    );
                return yield* makeLiveOntology(settings).pipe(
                    Effect.mapError((cause) => failure("installation.open", cause))
                );
            }),
        });
        const keyFor = (userId: string, ontologyId: string, meta: boolean) =>
            JSON.stringify([userId, ontologyId, meta]);
        const open = <T extends OntologyDefinition>(userId: string, ontologyId: string, meta: boolean) =>
            owned(
                locked(
                    userId,
                    Effect.andThen(ensureOpen, ScopedCache.get(cache, keyFor(userId, ontologyId, meta)))
                )
            ) as Effect.Effect<LiveOntology<T>, BackendError>;
        const close = (userId: string, ontologyId: string, meta: boolean) =>
            owned(locked(userId, ScopedCache.invalidate(cache, keyFor(userId, ontologyId, meta))));
        const closeUser = Effect.fnUntraced(function* (userId: string) {
            for (const key of yield* ScopedCache.keys(cache))
                if ((JSON.parse(key) as string[])[0] === userId) yield* ScopedCache.invalidate(cache, key);
        });
        const destroyUser = Effect.fnUntraced(function* (userId: string) {
            yield* closeUser(userId);
            const selected = yield* runtime.tables
                .loadSubset(partitions, { where: eq(field("userId"), userId) })
                .pipe(Effect.mapError((cause) => failure("installation.partition", cause)));
            for (const { value: partition } of selected) {
                const namespace = `${liveOntologyNamespace(options.installationId, partition.ontologyId)}${partition.meta ? ":meta" : ""}`;
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const platformScope = yield* Scope.fork(yield* Effect.scope);
                        const runtime = yield* Scope.provide(
                            options.runtime(partition.owner ?? userId, namespace),
                            platformScope
                        ).pipe(Effect.mapError((cause) => failure("installation.runtime", cause)));
                        yield* Scope.close(platformScope, Exit.void);
                        yield* boundary("installation.destroy", async () => {
                            await runtime.adapter.destroy?.();
                        });
                    })
                );
                yield* runtime.tables
                    .delete(partitions, partition.id)
                    .pipe(Effect.mapError((cause) => failure("installation.partition", cause)));
            }
        });
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
                disposed = true;
            })
        );
        return {
            installationId: options.installationId,
            authentication: connectionManager.authentication,
            connections: connectionManager.connections,
            connectionMonitor: (userId: string) => createConnectionMonitor(connectionManager, userId),
            openOntology: <T extends OntologyDefinition>({
                userId,
                ontologyId,
            }: {
                userId: string;
                ontologyId: string;
            }) => open<T>(userId, ontologyId, false),
            openMetaOntology: ({ userId, ontologyId }: { userId: string; ontologyId: string }) =>
                open<MetaOntology>(userId, ontologyId, true),
            closeOntology: ({ userId, ontologyId }: { userId: string; ontologyId: string }) =>
                close(userId, ontologyId, false),
            closeMetaOntology: ({ userId, ontologyId }: { userId: string; ontologyId: string }) =>
                close(userId, ontologyId, true),
            disconnect: (userId: string) =>
                owned(
                    locked(
                        userId,
                        Effect.gen(function* () {
                            yield* closeUser(userId);
                            yield* connectionManager
                                .disconnect(userId)
                                .pipe(Effect.mapError((cause) => failure("installation.disconnect", cause)));
                        })
                    )
                ),
            forget: (userId: string) =>
                owned(
                    locked(
                        userId,
                        Effect.gen(function* () {
                            // Attempt both, but preserve the partition record when destruction fails so forgetting can be retried.
                            const destroyed = yield* Effect.exit(destroyUser(userId));
                            const forgotten = yield* Effect.exit(
                                connectionManager
                                    .forget(userId)
                                    .pipe(Effect.mapError((cause) => failure("installation.forget", cause)))
                            );
                            yield* destroyed;
                            yield* forgotten;
                        })
                    )
                ),
        } satisfies OntologyBackendInstallationService<A>;
    }).pipe(Effect.provideService(Runtime, runtime));
});

/** Promise facade for framework code. It owns a scope; no lifecycle logic lives here. */
export async function createOntologyBackendInstallation<A extends object = object>(
    options: CreateOntologyBackendInstallationOptions<A>
): Promise<OntologyBackendInstallation<A>> {
    const owner = Effect.runSync(Scope.make());
    const run = <B>(effect: Effect.Effect<B, BackendError>) => Effect.runPromise(effect);
    try {
        const installation = await run(
            Effect.flatMap(
                Effect.forkIn(Scope.provide(makeOntologyBackendInstallation(options), owner), owner),
                Fiber.join
            )
        );
        let closing: Promise<void> | undefined;
        return {
            ...installation,
            openOntology: (options) => run(installation.openOntology(options)),
            openMetaOntology: (options) => run(installation.openMetaOntology(options)),
            closeOntology: (options) => run(installation.closeOntology(options)),
            closeMetaOntology: (options) => run(installation.closeMetaOntology(options)),
            disconnect: (id) => run(installation.disconnect(id)),
            forget: (id) => run(installation.forget(id)),
            cleanup: () => (closing ??= Effect.runPromise(Scope.close(owner, Exit.void))),
        };
    } catch (cause) {
        await Effect.runPromise(Scope.close(owner, Exit.fail(cause)));
        throw cause;
    }
}
