import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { serveInstallationWorker } from "@party-stack/ontology-server/installation/worker";
import { Runtimes } from "@party-stack/runtime";
import { Effect, Fiber, Layer, Schema } from "effect";
import { TRACKER_CACHE_EPOCH } from "./trackerConfig";

const Identity = Schema.Struct({
    cacheEpoch: Schema.Literal(TRACKER_CACHE_EPOCH),
    installationId: Schema.NonEmptyString,
});
const open = Effect.gen(function* () {
    const identity = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
        (globalThis as unknown as { name: string }).name
    ).pipe(
        Effect.mapError(
            (cause) =>
                new BackendError({
                    operation: "installation.identity",
                    kind: "InvalidConfiguration",
                    retryable: false,
                    message: "Invalid installation worker identity.",
                    cause,
                })
        )
    );
    const { makeTrackerInstallation, trackerRuntime } = yield* Effect.tryPromise({
        try: () => import("./installations"),
        catch: (cause) => classifyBackendFailure("installation.load", cause),
    });
    const context = yield* Layer.build(Runtimes.layer(trackerRuntime));
    return yield* makeTrackerInstallation(identity.installationId).pipe(Effect.provideContext(context));
});
Effect.runFork(
    Effect.scoped(
        Effect.gen(function* () {
            const server = yield* serveInstallationWorker({ open }).pipe(
                Effect.provide(BrowserWorkerRunner.layer)
            );
            yield* Fiber.join(server);
        })
    )
);
