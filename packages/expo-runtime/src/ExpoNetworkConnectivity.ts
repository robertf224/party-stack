import { makeNetworkConnectivity, RuntimeError } from "@party-stack/runtime";
import NetInfo from "@react-native-community/netinfo";
import { Effect } from "effect";

export const makeExpoNetworkConnectivity = Effect.fnUntraced(function* () {
    const initial = yield* Effect.tryPromise({
        try: () => NetInfo.fetch(),
        catch: (cause) => new RuntimeError({ operation: "expoRuntime.connectivity", cause }),
    });
    const state = yield* makeNetworkConnectivity(initial.isConnected === true);
    yield* Effect.acquireRelease(
        Effect.sync(() =>
            NetInfo.addEventListener((value) => {
                Effect.runSync(state.set(value.isConnected === true));
            })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
    );
    return { online: state.online, changes: state.changes };
});
