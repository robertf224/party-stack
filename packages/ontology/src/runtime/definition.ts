import { Effect, Stream } from "effect";
import type { LiveOntologyDefinition, LiveOntologyDefinitionStatus } from "../live/LiveOntology.js";
import type { OntologyClient } from "@party-stack/ontology-server/rpc";
import type { Scope } from "effect";

const current: LiveOntologyDefinitionStatus = { status: "current" };

/**
 * Whether the server still serves the definition this view opened with. A view fed by a client
 * becomes stale when an operation or delivery reports `SchemaMismatch` and the server's
 * description no longer matches. A source or account change is an error, not staleness.
 */
export const makeLiveDefinition = Effect.fnUntraced(function* (
    client: OntologyClient | undefined
): Effect.fn.Return<LiveOntologyDefinition, never, Scope.Scope> {
    let status = current;
    const listeners = new Set<() => void>();
    if (client?.definition)
        yield* client.definition.changes.pipe(
            Stream.runForEach((value) =>
                Effect.sync(() => {
                    const next: LiveOntologyDefinitionStatus =
                        value.status === "incompatible" && value.error?.kind === "SchemaMismatch"
                            ? { status: "stale", error: value.error }
                            : current;
                    if (next.status === status.status) return;
                    status = next;
                    for (const listener of [...listeners]) listener();
                })
            ),
            Effect.forkScoped
        );
    return {
        get: () => status,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
