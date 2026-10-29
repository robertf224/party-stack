import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { serveOpenedOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Effect, Schema } from "effect";
import { createTrackerInstallation, TRACKER_CACHE_EPOCH } from "./installations";

const Partition = Schema.Struct({
    cacheEpoch: Schema.Literal(TRACKER_CACHE_EPOCH),
    installationId: Schema.NonEmptyString,
    userId: Schema.NonEmptyString,
    ontologyId: Schema.NonEmptyString,
});

Effect.runFork(
    Effect.scoped(
        serveOpenedOntologyWorker({
            open: Effect.gen(function* () {
                const partition = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Partition))(
                    (globalThis as unknown as { name: string }).name
                ).pipe(
                    Effect.mapError(
                        () =>
                            new BackendError({
                                operation: "owner.partition",
                                kind: "InvalidConfiguration",
                                retryable: false,
                                message: "Invalid worker ontology partition.",
                            })
                    )
                );
                const installation = yield* Effect.acquireRelease(
                    Effect.tryPromise({
                        try: () => createTrackerInstallation(partition.installationId),
                        catch: (cause) => classifyBackendFailure("owner.installation", cause),
                    }),
                    (value) => Effect.promise(() => value.cleanup())
                );
                return yield* Effect.tryPromise({
                    try: () =>
                        installation.openOntology({
                            userId: partition.userId,
                            ontologyId: partition.ontologyId,
                        }),
                    catch: (cause) => classifyBackendFailure("owner.open", cause),
                });
            }),
            errors: "forward",
            // Trusted same-origin clients share one principal/installation partition.
            authorize: () => Effect.void,
        }).pipe(Effect.provide(BrowserWorkerRunner.layer))
    )
);
