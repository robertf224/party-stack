import { BackendError } from "@party-stack/ontology-backend";
import { Effect } from "effect";
import { createOntologyBackendInstallation } from "../installation/createOntologyBackendInstallation.js";
import type { CreateOntologyBackendInstallationOptions } from "../installation/types.js";

/** Scoped entry point. Cleanup releases connections and live ontologies while
 * keeping credentials, persisted rows, and pending invocations for restoration.
 */
export const makeOntologyBackendInstallation = Effect.fn("OntologyInstallation.make")(function* <
    AuthenticationClient extends object = object,
>(options: CreateOntologyBackendInstallationOptions<AuthenticationClient>) {
    return yield* Effect.acquireRelease(
        Effect.tryPromise({
            try: () => createOntologyBackendInstallation(options),
            catch: (cause) =>
                new BackendError({
                    operation: "installation.open",
                    kind: "Unavailable",
                    message: "Could not open the backend installation.",
                    retryable: true,
                    cause,
                }),
        }),
        (installation) => Effect.promise(() => installation.cleanup())
    );
});
