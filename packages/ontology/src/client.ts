import { Effect, Exit, Scope } from "effect";
import type { BackendError } from "@party-stack/ontology-backend";
import type { OntologyServerClient } from "@party-stack/ontology-server/rpc";

/** Open one shared transport at an application boundary. Selected views borrow it. */
export async function createOntologyClient(
    open: Effect.Effect<OntologyServerClient, BackendError, Scope.Scope>
) {
    const scope = Effect.runSync(Scope.make());
    try {
        const client = await Effect.runPromise(Scope.provide(open, scope));
        let closing: Promise<void> | undefined;
        return { ...client, cleanup: () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void))) };
    } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
        throw cause;
    }
}
