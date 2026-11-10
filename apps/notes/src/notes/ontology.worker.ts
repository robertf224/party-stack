import { runMain } from "@effect/platform-browser/BrowserRuntime";
import { layer as workerRunner } from "@effect/platform-browser/BrowserWorkerRunner";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { TraceRecording } from "@party-stack/runtime/tracing";
import { webRuntime } from "@party-stack/web-runtime";
import { Effect, Fiber } from "effect";
import { notesServer } from "./notes-server";
serveOntologyWorker(notesServer).pipe(
    Effect.provideService(TraceRecording, import.meta.env.DEV ? "buffer" : "live"),
    Effect.flatMap(Fiber.join),
    Effect.scoped,
    Effect.provide(webRuntime({ persistEncryptionKeys: true })),
    Effect.provide(workerRunner),
    runMain
);
