import { makeTraceCapture, type TraceRecordingMode } from "@party-stack/runtime/tracing";
import { Effect, Tracer } from "effect";
import { makeReplicaHost, type ReplicaHostOptions } from "./host.js";
import { makeReplicaOntologyView } from "./view.js";

export type ReplicaLiveOptions = ReplicaHostOptions & { readonly traceRecording?: TraceRecordingMode };
/** Native host acquisition with an independently configured tracer. No UI collections. */
export const makeReplicaResource = Effect.fnUntraced(function* (options: ReplicaLiveOptions) {
    const traces = yield* makeTraceCapture(options.traceRecording);
    const open = makeReplicaHost(options).pipe(Effect.map((host) => ({ ...host, traces })));
    return yield* traces ? open.pipe(Effect.provideService(Tracer.Tracer, traces.tracer)) : open;
});

/** SDK view over a scoped native host. */
export const makeReplicaLiveOntology = Effect.fnUntraced(function* (options: ReplicaLiveOptions) {
    const { replica, attachments, traces } = yield* makeReplicaResource(options);
    const view = makeReplicaOntologyView({
        ir: options.ir,
        context: options.context,
        replica,
        writes: options.writes,
        attachments,

        traces,
    });
    return yield* traces ? view.pipe(Effect.provideService(Tracer.Tracer, traces.tracer)) : view;
});
