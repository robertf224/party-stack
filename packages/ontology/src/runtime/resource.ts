import { BackendError } from "@party-stack/ontology-backend";
import { equalValues } from "@party-stack/ontology-spec/query";
import { contextPartition } from "@party-stack/ontology-spec/utils";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { digestBytes } from "@party-stack/ontology-storage/blobs";
import { Runtime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Scope, Tracer, Stream } from "effect";
import { makeReplicaResource } from "./live.js";
import { makeReplicaOntologyView } from "./view.js";
import type { LiveOntologyOptions, LiveOntology, OntologyDefinition } from "../live/LiveOntology.js";
/** Native acquisition. Runtime, backend, collections and replica fibers share the caller's Scope. */
export const makeOntologyResource = Effect.fn("Ontology.acquire")(function* <
    Ontology extends OntologyDefinition = OntologyDefinition,
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: LiveOntologyOptions<Context>) {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const opened = Effect.gen(function* () {
        // Close views/replication first, then transport, then local platform storage.
        const platformScope = yield* Scope.fork(scope);
        const transportScope = yield* Scope.fork(scope);
        const remote = opts.client
            ? yield* Scope.provide(
                  Effect.isEffect(opts.client) ? opts.client : Effect.succeed(opts.client),
                  transportScope
              )
            : undefined;
        const client =
            remote && "ontology" in remote
                ? yield* Scope.provide(remote.ontology(opts.ontology), transportScope)
                : remote;
        const ir = opts.ir ?? client?.ir;
        if (!ir)
            return yield* new BackendError({
                operation: "ontology.create",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Supply an ontology definition when the server does not describe one.",
            });
        if (client && opts.ir && client.definitionHash) {
            const signature = yield* Effect.try({
                try: () => ontologyDefinitionSignature(ir),
                catch: (cause) =>
                    new BackendError({
                        operation: "ontology.create",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message: "Invalid client ontology definition.",
                        cause,
                    }),
            });
            const hash = yield* digestBytes({
                type: "application/json",
                stream: Stream.make(new TextEncoder().encode(signature)),
            }).pipe(
                Effect.mapError(
                    (cause) =>
                        new BackendError({
                            operation: "ontology.create",
                            kind: "Internal",
                            retryable: false,
                            message: "Could not identify the client definition.",
                            cause,
                        })
                )
            );
            if (hash !== client.definitionHash)
                return yield* new BackendError({
                    operation: "ontology.create",
                    kind: "SchemaMismatch",
                    retryable: false,
                    message: "Server definition differs from this client.",
                });
        }
        if (client?.context && opts.context && !equalValues(client.context, opts.context))
            return yield* new BackendError({
                operation: "ontology.create",
                kind: "InvalidConfiguration",
                retryable: false,
                message: "Client context differs from the authenticated server context.",
            });
        const ontologyId = opts.id ?? (client ? JSON.stringify(["source", client.sourceId]) : "default");
        const context = (client?.context ?? opts.context ?? {}) as Context;
        const owner = yield* Effect.try({
            try: () => contextPartition(ir, context),
            catch: (cause) =>
                new BackendError({
                    operation: "runtime.partition",
                    kind: "InvalidConfiguration",
                    message: "Invalid context partition.",
                    retryable: false,
                    cause,
                }),
        });
        const runtime = yield* Scope.provide(
            Effect.flatMap(Runtimes, (runtimes) => runtimes.acquire({ owner, namespace: ontologyId })),
            platformScope
        );
        const resources = yield* Scope.fork(yield* Effect.scope);
        return yield* Scope.provide(
            Effect.gen(function* () {
                const source =
                    client?.replication.kind === "speculative" ? client.replication.source : undefined;
                const backend =
                    client?.backend ??
                    (yield* (
                        Effect.isEffect(opts.backend) ? opts.backend : Effect.succeed(opts.backend!)
                    ).pipe(Effect.provideService(Runtime, runtime)));
                const host = yield* makeReplicaResource({
                    backend,
                    source,
                    ir,
                    traceRecording: opts.traceRecording,
                    context,
                    writes: opts.writes,
                    live: opts.live,
                    demand: opts.demand,
                    cache: opts.cache,
                    authentication: opts.authentication,
                }).pipe(Effect.provideService(Runtime, runtime));
                const close = Scope.close(scope, Exit.void);
                const view = yield* Effect.cached(
                    Scope.provide(
                        makeReplicaOntologyView({
                            ir,
                            context,
                            replica: host.replica,
                            writes: opts.writes,
                            attachments: host.attachments,
                            pins: client?.pins,
                            pinBackend: client?.pinBackend,
                            diagnosticLabel: opts.label,
                            parentDiagnostics:
                                client && (source || opts.parent)
                                    ? {
                                          label: opts.parent?.label ?? "Parent",
                                          role: "host",
                                          location: opts.parent?.location,
                                          replica: client.operations.replicaMonitor,
                                          traces: client.operations.traces,
                                      }
                                    : undefined,
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
                                }) as LiveOntology<Ontology>
                        )
                    )
                );
                return { ...host, ir, context, close, view };
            }),
            resources
        );
    });
    return yield* Scope.provide(opened, scope).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
    );
});

export type OntologyResource = Effect.Success<ReturnType<typeof makeOntologyResource>>;
