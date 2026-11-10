import { BackendError } from "@party-stack/ontology-backend";
import { Effect, Exit, Pull, Scope, Stream } from "effect";

/** Keep the same scoped RPC pull alive after its first readiness frame. Reading
 * a head in a separate scope would close the upstream watch before the snapshot.
 */
export const acquireRpcWatch = Effect.fnUntraced(function* <A>(
    stream: Stream.Stream<A, BackendError>,
    ready: A,
    operation: string
) {
    const scope = yield* Scope.fork(yield* Effect.scope);
    return yield* Scope.provide(
        Effect.gen(function* () {
            const pull = yield* Stream.toPull(stream);
            const first = yield* pull.pipe(
                Pull.catchDone(() =>
                    Effect.fail(
                        new BackendError({
                            operation,
                            kind: "Unavailable",
                            retryable: true,
                            message: "The watch ended before its subscription was ready.",
                        })
                    )
                )
            );
            if (first[0] !== ready)
                return yield* new BackendError({
                    operation,
                    kind: "InvalidResponse",
                    retryable: false,
                    message: "The watch did not confirm its subscription.",
                });
            return Stream.concat(Stream.fromIterable(first.slice(1)), Stream.fromPull(Effect.succeed(pull)));
        }),
        scope
    ).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)));
});
