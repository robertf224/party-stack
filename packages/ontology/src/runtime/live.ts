import { BackendError } from "@party-stack/ontology-backend";
import { Runtime, getRuntime } from "@party-stack/runtime";
import { Effect, Scope } from "effect";
import { makeReplicaHost, type ReplicaHostOptions } from "./host.js";
import { makeReplicaOntologyView } from "./view.js";
import type { LiveOntology } from "../live/LiveOntology.js";

const failure = (cause: unknown) =>
    cause instanceof BackendError
        ? cause
        : new BackendError({
              operation: "ontology",
              kind: "Unavailable",
              message: cause instanceof Error ? cause.message : "Ontology operation failed.",
              retryable: true,
              cause,
          });
export type ReplicaLiveOptions = ReplicaHostOptions;
/** Primary scoped implementation; only the outer createLiveOntology bridge owns a standalone scope. */
export const makeReplicaLiveOntology = Effect.fn("Ontology.open")(function* (
    options: ReplicaLiveOptions
): Effect.fn.Return<Omit<LiveOntology, "cleanup" | "destroy">, BackendError, Runtime | Scope.Scope> {
    const { runtime, context, ir } = options;
    if (runtime.acquireHost) yield* runtime.acquireHost.pipe(Effect.mapError(failure));
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
        traces: getRuntime(runtime).traces,
        validate: backend.validateAction
            ? (name, parameters) => backend.validateAction!(name, parameters)
            : undefined,
        validateDraft: backend.validateAction
            ? (name, parameters, knownParameters) =>
                  backend.validateAction!(name, parameters, { knownParameters })
            : undefined,
    });
});
