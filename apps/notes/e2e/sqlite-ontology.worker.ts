/// <reference types="vite/client" />

import { runMain } from "@effect/platform-browser/BrowserRuntime";
import { layer as workerRunner } from "@effect/platform-browser/BrowserWorkerRunner";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { createTraceCapture, TraceRecording } from "@party-stack/runtime/tracing";
import { Effect, Fiber, Schema, Tracer } from "effect";
import { notesServer } from "../src/notes/notes-server";
import { sqliteOpfsRuntime } from "./sqlite-runtime";

// Diagnostic reads avoid introducing another ontology client while cache setup is pending.
const trace = createTraceCapture(1024);
const recordTrace = new URL(globalThis.location.href).searchParams.get("sqlTrace") === "1";
Object.defineProperty(globalThis, "__sqlBenchmarkTraces", { value: trace.getSnapshot });

const Bootstrap = Schema.Struct({
    kind: Schema.Literal("notes-sqlite-host"),
    port: Schema.instanceOf(MessagePort),
});
const firstConnection = Effect.callback<{ port: MessagePort; control: MessagePort }, Schema.SchemaError>(
    (resume) => {
        let control: MessagePort | undefined;
        let accepted = false;
        const connect: EventListener = (event) => {
            event.stopImmediatePropagation();
            globalThis.removeEventListener("connect", connect);
            control = (event as MessageEvent).ports[0]!;
            control.onmessage = (event) => {
                accepted = true;
                resume(
                    Schema.decodeUnknownEffect(Bootstrap)(event.data).pipe(
                        Effect.map((value) => ({ port: value.port, control: control! })),
                        Effect.onError(() => Effect.sync(() => control?.close()))
                    )
                );
            };
            control.start();
        };
        globalThis.addEventListener("connect", connect);
        return Effect.sync(() => {
            globalThis.removeEventListener("connect", connect);
            if (control) control.onmessage = null;
            if (!accepted) control?.close();
        });
    }
);

Effect.gen(function* () {
    const host = yield* Effect.acquireRelease(firstConnection, (value) =>
        Effect.sync(() => {
            value.control.close();
            value.port.close();
        })
    );
    yield* Effect.gen(function* () {
        const server = yield* serveOntologyWorker(notesServer);
        yield* Effect.sync(() => host.control.postMessage({ kind: "notes-sqlite-ready" }));
        yield* Fiber.join(server);
    }).pipe(
        Effect.provideService(TraceRecording, import.meta.env.DEV ? "buffer" : "live"),
        Effect.provide(sqliteOpfsRuntime(host.port)),
        Effect.provide(workerRunner)
    );
}).pipe(
    Effect.scoped,
    Effect.provideService(Tracer.Tracer, recordTrace ? trace.tracer : Tracer.nativeTracer),
    runMain
);
