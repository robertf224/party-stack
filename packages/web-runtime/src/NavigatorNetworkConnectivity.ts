import { makeNetworkConnectivity } from "@party-stack/runtime";
import { Effect, PubSub, Stream } from "effect";

const ONLINE_STABILIZATION_MS = 1_000;

/** Native listeners and stabilization belong to the caller's platform scope. */
export const makeNavigatorNetworkConnectivity = Effect.fnUntraced(function* () {
    const state = yield* makeNetworkConnectivity(navigator.onLine !== false);
    const target = typeof window === "undefined" ? globalThis : window;
    const events = yield* Effect.acquireRelease(
        PubSub.sliding<void>({ capacity: 1, replay: 1 }),
        PubSub.shutdown
    );
    const changed = () => {
        PubSub.publishUnsafe(events, undefined);
    };
    yield* Effect.acquireRelease(
        Effect.sync(() => {
            target.addEventListener("online", changed);
            target.addEventListener("offline", changed);
        }),
        () =>
            Effect.sync(() => {
                target.removeEventListener("online", changed);
                target.removeEventListener("offline", changed);
            })
    );
    const changes = Stream.fromPubSub(events).pipe(
        Stream.switchMap(() =>
            Stream.fromEffect(
                Effect.gen(function* () {
                    if (navigator.onLine !== false && !(yield* state.online))
                        yield* Effect.sleep(ONLINE_STABILIZATION_MS);
                    yield* state.set(navigator.onLine !== false);
                })
            )
        )
    );
    yield* Stream.runDrain(changes).pipe(Effect.forkScoped({ startImmediately: true }));
    return {
        online: state.online.pipe(Effect.map((online) => navigator.onLine !== false && online)),
        changes: state.changes,
    };
});
