import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Scope, Tracer } from "effect";
import { provide } from "../utils/provide.js";
import { makeReplicaResource } from "./live.js";
import { makeReplicaOntologyView } from "./view.js";
import type { CreateLiveOntologyOpts, LiveOntology, OntologyDefinition } from "../live/LiveOntology.js";
/** Native acquisition. Runtime, backend, collections and replica fibers share the caller's Scope. */
export const makeOntologyResource = Effect.fn("Ontology.acquire")(function* <
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: Omit<CreateLiveOntologyOpts<Context>, "runtime">) {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const opened = Effect.gen(function* () {
        const ontologyId = opts.id ?? "default";
        const context = (opts.context ?? {}) as Context;
        const owner = yield* Effect.try({
            try: () => contextPartition(opts.ir, context),
            catch: (cause) =>
                new BackendError({
                    operation: "runtime.partition",
                    kind: "InvalidConfiguration",
                    message: "Invalid context partition.",
                    retryable: false,
                    cause,
                }),
        });
        const runtime = yield* Effect.flatMap(Runtimes, (runtimes) =>
            runtimes.acquire({ owner, namespace: ontologyId })
        );
        const platform = runtime;
        const resources = yield* Scope.fork(yield* Effect.scope);
        return yield* Scope.provide(
            Effect.gen(function* () {
                const backendAdapter = yield* Effect.tryPromise({
                    try: () => provide(opts.backend, opts.ir, context),
                    catch: (cause) => classifyBackendFailure("backend.configure", cause),
                });
                const host = yield* makeReplicaResource({
                    ir: opts.ir,
                    traceRecording: opts.traceRecording,
                    context,
                    backendAdapter,
                    writes: opts.writes,
                    live: opts.live,
                    demand: opts.demand,
                    cache: opts.cache,
                    connection: opts.connection,
                }).pipe(Effect.provideService(Runtime, runtime));
                const close = Scope.close(scope, Exit.void);
                const destroy = close.pipe(
                    Effect.andThen(platform.destroy),
                    Effect.mapError((cause) => classifyBackendFailure("ontology.destroy", cause))
                );
                const view = yield* Effect.cached(
                    Scope.provide(
                        makeReplicaOntologyView({
                            ir: opts.ir,
                            context,
                            replica: host.replica,
                            writes: opts.writes,
                            attachments: host.attachments,
                            queryFunction: host.backend.queryFunction,
                            traces: host.traces,
                        }).pipe(Effect.provideService(Runtime, runtime), (work) =>
                            host.traces
                                ? work.pipe(Effect.provideService(Tracer.Tracer, host.traces.tracer))
                                : work
                        ),
                        resources
                    ).pipe(
                        Effect.map(
                            (view) =>
                                ({
                                    ...view,
                                    cleanup: () => Effect.runPromise(close),
                                    destroy: () => Effect.runPromise(destroy),
                                }) as LiveOntology<Ontology>
                        )
                    )
                );
                return { ...host, ir: opts.ir, context, close, destroy, view };
            }),
            resources
        );
    });
    return yield* Scope.provide(opened, scope).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
    );
});

export type OntologyResource = Effect.Success<ReturnType<typeof makeOntologyResource>>;
