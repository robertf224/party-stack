import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { makeOntologyServer } from "@party-stack/ontology-server";
import {
    makeOntologyWorkerClient,
    serveOntologyWorker as serveNativeOntologyWorker,
} from "@party-stack/ontology-server/rpc/worker";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { TraceRecording } from "@party-stack/runtime/tracing";
import { Effect, Fiber } from "effect";
import { makeOntologyResource } from "./runtime/resource.js";
import type { CreateLiveOntologyOpts } from "./live/LiveOntology.js";

export interface WorkerClientOptions {
    /** Worker transport startup deadline; does not limit ontology/backend initialization. */
    readonly connectionTimeoutMs?: number;
    readonly ontology?: string;
}

/** The factory runs only when the view opens. Vite can still discover a literal worker constructor. */
const acquireWorker = (spawn: () => Worker | SharedWorker | MessagePort) =>
    Effect.acquireRelease(Effect.sync(spawn), (worker) =>
        Effect.sync(() => {
            if ("port" in worker) worker.port.close();
            else if ("terminate" in worker) worker.terminate();
            else worker.close();
        })
    );
export const workerClient = Effect.fnUntraced(function* (
    spawn: () => Worker | SharedWorker | MessagePort,
    options?: WorkerClientOptions
) {
    const worker = yield* acquireWorker(spawn);
    return yield* makeOntologyWorkerClient(options).pipe(Effect.provide(BrowserWorker.layer(() => worker)));
});

/** Complete non-Effect setup for a single private browser replica. Native server
 * composition uses ontology-server/rpc/worker directly with an Effect entrypoint.
 */
export function serveOntologyWorker<Context extends Record<string, unknown> = Record<string, unknown>>(
    options: CreateLiveOntologyOpts<Context> & { readonly enableRealtime?: boolean }
) {
    const server = Effect.gen(function* () {
        const resource = yield* makeOntologyResource({
            ...options,
            traceRecording: options.traceRecording ?? "live",
        });
        return yield* makeOntologyServer({
            enableRealtime: options.enableRealtime,
            kind: "replica",
            replica: resource.replica,
            backend: resource.backend,
            ir: resource.ir,
            traces: resource.traces,
            dangerouslyAllowInternalAccess: true,
        });
    });
    const work = serveNativeOntologyWorker(server).pipe(
        Effect.flatMap(Fiber.join),
        Effect.scoped,
        Effect.provideService(TraceRecording, options.traceRecording ?? "live"),
        Effect.provide(options.runtime ?? Runtimes.layer(MemoryRuntime.layer)),
        Effect.provide(BrowserWorkerRunner.layer)
    );
    const fiber = Effect.runFork(work);
    return { cleanup: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined) };
}
