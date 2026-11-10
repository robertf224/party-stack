import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeOntologyLocalClient } from "@party-stack/ontology-server/rpc/local";
import { Effect, Exit, Scope } from "effect";
import type { BackendError } from "@party-stack/ontology-backend";
import type { OntologyServer } from "@party-stack/ontology-server";
import type { OntologyServerClient } from "@party-stack/ontology-server/rpc";

export interface LocalClientOptions {
    readonly ontology?: string;
}

/** Same-process client over the normal server routes and RPC handlers.
 * An Effect factory is acquired with the client and closed with its scope.
 * An already acquired server is borrowed and keeps its existing lifetime.
 */
export const localClient = Effect.fnUntraced(function* <R = never, E = never, ROpen = never>(
    server: OntologyServer<R> | Effect.Effect<OntologyServer<R>, E, ROpen>,
    options?: LocalClientOptions
): Effect.fn.Return<OntologyServerClient, BackendError, R | ROpen | Scope.Scope> {
    const scope = yield* Scope.fork(yield* Effect.scope);
    return yield* Scope.provide(
        Effect.gen(function* () {
            const opened = yield* Effect.isEffect(server) ? server : Effect.succeed(server);
            return yield* makeOntologyLocalClient(opened, options);
        }).pipe(Effect.mapError((cause) => classifyBackendFailure("ontology.local", cause))),
        scope
    ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)));
});
