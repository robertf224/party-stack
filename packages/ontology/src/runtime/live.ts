import { BackendError } from "@party-stack/ontology-backend";
import { Runtime } from "@party-stack/runtime";
import { makeTraceCapture, type TraceRecordingMode } from "@party-stack/runtime/tracing";
import { Effect, Scope, Tracer } from "effect";
import { makeReplicaHost, type ReplicaHostOptions } from "./host.js";
import { makeReplicaOntologyView } from "./view.js";
import type { LiveOntology } from "../live/LiveOntology.js";

export type ReplicaLiveOptions = ReplicaHostOptions & { readonly traceRecording?: TraceRecordingMode };
/** Primary scoped implementation; only the outer createLiveOntology bridge owns a standalone scope. */
export const makeReplicaLiveOntology = Effect.fnUntraced(function* (
    options: ReplicaLiveOptions
): Effect.fn.Return<Omit<LiveOntology, "cleanup" | "destroy">, BackendError, Runtime | Scope.Scope> {
    const traces = yield* makeTraceCapture(options.traceRecording);
    const open = Effect.gen(function* () {
        const { context, ir } = options;
        const { replica, backend, attachments } = yield* makeReplicaHost(options);
        return yield* makeReplicaOntologyView({
            ir,
            context,
            replica,
            writes: options.writes,
            queryFunction: backend.queryFunction,
            resolveActionParameters: backend.resolveActionParameters,
            sourceId: backend.sourceId,
            encrypted: backend.encrypted,
            attachments,
            traces,
            validate: backend.validateAction
                ? (name, parameters) => backend.validateAction!(name, parameters)
                : undefined,
            validateDraft: backend.validateAction
                ? (name, parameters, knownParameters) =>
                      backend.validateAction!(name, parameters, { knownParameters })
                : undefined,
        });
    }).pipe(Effect.withSpan("Ontology.open"));
    return yield* traces ? open.pipe(Effect.provideService(Tracer.Tracer, traces.tracer)) : open;
});
