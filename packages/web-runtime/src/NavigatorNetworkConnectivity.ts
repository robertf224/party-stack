import { makeNetworkConnectivity } from "@party-stack/runtime";
import { Effect, PubSub, Stream } from "effect";

const ONLINE_STABILIZATION_MS = 1_000;
const WORKER_CONNECTIVITY_SAMPLE_MS = 1_000;

/** Native listeners and stabilization belong to the caller's platform scope. */
export const makeNavigatorNetworkConnectivity = Effect.fnUntraced(function* () {
    const state = yield* makeNetworkConnectivity(navigator.onLine !== false);
    const target = typeof window === "undefined" ? globalThis : window;
    const events = yield* Effect.acquireRelease(
        PubSub.sliding<void>({ capacity: 1, replay: 1 }),
        PubSub.shutdown
    );
    let observed = navigator.onLine !== false;
    const changed = () => {
        observed = navigator.onLine !== false;
        PubSub.publishUnsafe(events, undefined);
    };
    const sample = () => {
        if (observed !== (navigator.onLine !== false)) changed();
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
    // SharedWorkers can observe onLine changes without receiving native events
    // (including Chromium's emulated offline mode). Sample only the local flag.
    if (typeof window === "undefined")
        yield* Effect.forever(
            Effect.sleep(WORKER_CONNECTIVITY_SAMPLE_MS).pipe(Effect.andThen(Effect.sync(sample)))
        ).pipe(Effect.forkScoped);
    return {
        online: state.online.pipe(
            Effect.map((online) => {
                // Remember even a short offline period noticed between worker samples.
                sample();
                return navigator.onLine !== false && online;
            })
        ),
        changes: state.changes,
    };
});
