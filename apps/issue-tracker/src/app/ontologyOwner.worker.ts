import { runMain } from "@effect/platform-browser/BrowserRuntime";
import { layer as workerRunner } from "@effect/platform-browser/BrowserWorkerRunner";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Runtimes } from "@party-stack/runtime";
import { TraceRecording } from "@party-stack/runtime/tracing";
import { Effect, Fiber } from "effect";
import { makeTrackerOntologyServer, trackerRuntime } from "./ontologyServer";

serveOntologyWorker(makeTrackerOntologyServer()).pipe(
    Effect.flatMap(Fiber.join),
    Effect.scoped,
    Effect.provide(Runtimes.layer(trackerRuntime)),
    Effect.provide(workerRunner),
    Effect.provideService(TraceRecording, "live"),
    runMain
);
