import { BackendError } from "@party-stack/ontology-backend";
import { Effect, Fiber } from "effect";
import type { ConnectionEgress, ConnectionEgressHandlers } from "./types.js";

/** Promise boundary for third-party SDKs. Operations remain owned by the
 * acquiring scope; closing it cancels in-flight work and rejects later calls.
 */
export const toWebEgress = Effect.fnUntraced(function* (egress: ConnectionEgress | ConnectionEgressHandlers) {
    const scope = yield* Effect.scope;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const owned = <A>(work: Effect.Effect<A, BackendError>) =>
        Effect.suspend(() =>
            scope.state._tag === "Closed"
                ? Effect.fail(
                      new BackendError({
                          operation: "connect.egress",
                          kind: "Unavailable",
                          retryable: false,
                          message: "The selected connection was released.",
                      })
                  )
                : Effect.acquireUseRelease(Effect.forkIn(work, scope), Fiber.join, Fiber.interrupt)
        );
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        return run(owned(egress.fetch(request)), { signal: request.signal });
    };
    return {
        fetch,
        createWebSocket: (url: string | URL, protocols?: string | string[]) =>
            run(owned(egress.createWebSocket(url, protocols))),
    };
});
