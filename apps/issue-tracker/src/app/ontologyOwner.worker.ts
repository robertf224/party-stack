import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { BackendError } from "@party-stack/ontology-backend";
import { replicaStateSource } from "@party-stack/ontology-replica";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { createTrackerInstallation } from "./installations";
import type { LiveOntology } from "@party-stack/ontology";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

const Partition = Schema.Struct({
    installationId: Schema.NonEmptyString,
    userId: Schema.NonEmptyString,
    ontologyId: Schema.NonEmptyString,
});
const partition = Schema.decodeUnknownSync(Schema.fromJsonString(Partition))(
    (globalThis as unknown as { name: string }).name
);

Effect.runFork(
    Effect.scoped(
        Effect.gen(function* () {
            const ready = yield* Deferred.make<OntologySource, BackendError>();
            const released = yield* Deferred.make<void>();
            let ontology: LiveOntology | undefined;
            let source: OntologySource | undefined;
            const current = Deferred.await(ready);
            // Start the transport before restoring credentials; startup failures reach Describe as typed errors.
            const proxy: OntologySource = {
                get sourceId() {
                    return source?.sourceId ?? "initializing";
                },
                get supportsIdempotency() {
                    return source?.supportsIdempotency ?? false;
                },
                openClient: (resume) => Effect.flatMap(current, (value) => value.openClient(resume)),
                read: (session, view) => Effect.flatMap(current, (value) => value.read(session, view)),
                submit: (request) => Effect.flatMap(current, (value) => value.submit(request)),
                acknowledge: (...args) => Effect.flatMap(current, (value) => value.acknowledge(...args)),
                demand: (subset) => Effect.flatMap(current, (value) => value.demand(subset)),
                subscribeChanges: Effect.flatMap(current, (value) => value.subscribeChanges),
            };
            yield* Effect.forkScoped(
                Effect.gen(function* () {
                    const installation = yield* Effect.acquireRelease(
                        Effect.tryPromise({
                            try: () => createTrackerInstallation(partition.installationId),
                            catch: (cause) =>
                                new BackendError({
                                    operation: "owner.installation",
                                    kind: "Unavailable",
                                    retryable: true,
                                    message:
                                        cause instanceof Error
                                            ? cause.message
                                            : "Could not restore installation.",
                                    cause,
                                }),
                        }),
                        (installation) => Effect.promise(() => installation.cleanup())
                    );
                    const opened = yield* Effect.tryPromise({
                        try: () =>
                            installation.openOntology({
                                userId: partition.userId,
                                ontologyId: partition.ontologyId,
                            }),
                        catch: (cause) =>
                            cause instanceof BackendError
                                ? cause
                                : new BackendError({
                                      operation: "owner.open",
                                      kind: "Unavailable",
                                      retryable: true,
                                      message:
                                          cause instanceof Error ? cause.message : "Could not open ontology.",
                                      cause,
                                  }),
                    });
                    ontology = opened;
                    if (!opened.storage)
                        return yield* new BackendError({
                            operation: "owner.open",
                            kind: "NotImplemented",
                            retryable: false,
                            message: "Shared ontology requires a replica.",
                        });
                    source = replicaStateSource(opened.storage);
                    yield* Deferred.succeed(ready, source);
                }).pipe(Effect.catch((error) => Deferred.fail(ready, error)))
            );
            const server = yield* serveOntologyWorker({
                source: proxy,
                errors: "forward",
                get ontology() {
                    return ontology;
                },
                ready: Effect.asVoid(current),
                deleteLocalData: Effect.flatMap(current, () =>
                    Effect.tryPromise({
                        try: () => ontology!.destroy(),
                        catch: (cause) =>
                            new BackendError({
                                operation: "owner.deleteLocalData",
                                kind: "Unavailable",
                                retryable: true,
                                message: "Could not delete the local partition.",
                                cause,
                            }),
                    })
                ),
                releaseOwner: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
                // The same-origin worker is bound to one principal/installation partition.
                authorize: () => Effect.void,
            }).pipe(Effect.provide(BrowserWorkerRunner.layer));
            yield* Effect.raceFirst(Fiber.join(server), Deferred.await(released));
        })
    )
);
