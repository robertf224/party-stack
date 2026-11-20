import { BackendError } from "@party-stack/ontology-backend";
import { Effect } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";

// A backend that throws (a defect) instead of failing with a `BackendError` would
// otherwise skip the replica's failure handling: a reader or pass dies, a load's
// cleanup reports success, or the outbox worker stops for good. Every request the
// replica makes fails with `Internal` instead. Subscriptions (subset watches, the
// change watch and delivery) run under `superviseWatch`, which already does this.
const crashed = (operation: string, defect: unknown, actionOutcome?: "unknown") =>
    new BackendError({
        operation,
        kind: "Internal",
        message: "The backend failed unexpectedly.",
        retryable: false,
        cause: defect,
        // An action that crashed mid-dispatch may have committed.
        ...(actionOutcome ? { actionOutcome } : {}),
    });

const guard = <A>(
    operation: string,
    request: () => Effect.Effect<A, BackendError>,
    actionOutcome?: "unknown"
): Effect.Effect<A, BackendError> =>
    Effect.suspend(request).pipe(
        Effect.catchDefect((defect) => Effect.fail(crashed(operation, defect, actionOutcome)))
    );

/** Wraps a backend so that defects in its requests become `Internal` failures. */
export const guardBackend = (backend: OntologyBackendService): OntologyBackendService => ({
    ...backend,
    ...(backend.maintenance && { maintenance: guard("maintenance", () => backend.maintenance!) }),
    loadSubset: (subset) => guard("loadSubset", () => backend.loadSubset(subset)),
    query: (document, options) => guard("query", () => backend.query(document, options)),
    ...(backend.acknowledgeDelivery && {
        acknowledgeDelivery: (position) =>
            guard("acknowledgeDelivery", () => backend.acknowledgeDelivery!(position)),
    }),
    ...(backend.resolveActionParameters && {
        resolveActionParameters: (name, parameters) =>
            guard("resolveActionParameters", () => backend.resolveActionParameters!(name, parameters)),
    }),
    ...(backend.validateAction && {
        validateAction: (name, parameters, options) =>
            guard("validateAction", () => backend.validateAction!(name, parameters, options)),
    }),
    applyAction: (invocation) => guard("applyAction", () => backend.applyAction(invocation), "unknown"),
    queryFunction: (name, parameters) =>
        guard("queryFunction", () => backend.queryFunction(name, parameters)),
    ...(backend.changes && {
        changes: {
            ...backend.changes,
            pull: (options) => guard("changes.pull", () => backend.changes!.pull(options)),
        },
    }),
});
