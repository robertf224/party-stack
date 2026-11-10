import { Effect, PubSub, Stream } from "effect";
import type { NetworkConnectivity } from "./types.js";

/** Platforms without a monitor still handle individual request failures normally. */
export const alwaysOnlineConnectivity: NetworkConnectivity = {
    online: Effect.succeed(true),
    changes: Stream.make(true),
};

/** Latest-value state with bounded delivery, owned by the platform scope. */
export const makeNetworkConnectivity = Effect.fnUntraced(function* (initial: boolean) {
    const events = yield* Effect.acquireRelease(
        PubSub.sliding<boolean>({ capacity: 1, replay: 1 }),
        PubSub.shutdown
    );
    let current = initial;
    yield* PubSub.publish(events, initial);
    return {
        online: Effect.sync(() => current),
        changes: Stream.fromPubSub(events),
        set: (value: boolean) =>
            Effect.sync(() => {
                if (value === current) return;
                current = value;
                PubSub.publishUnsafe(events, value);
            }),
    };
});
