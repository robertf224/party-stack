import {
    createSignal,
    resource,
    until,
    type Operation,
    type Stream,
} from "effection";
import type {
    RuntimeAdapter,
    RuntimeAdapterProvider,
} from "../types.js";

export function useRuntimeAdapter(
    provider: RuntimeAdapter | RuntimeAdapterProvider,
    owner: string,
    namespace: string
): Operation<RuntimeAdapter> {
    return resource(function* (provide) {
        const runtime =
            typeof provider === "function"
                ? yield* until(
                      Promise.resolve(provider(owner, namespace))
                  )
                : provider;
        try {
            yield* provide(runtime);
        } finally {
            yield* until(
                Promise.resolve(runtime.cleanup?.())
            );
        }
    });
}

export function useConnectivityChanges(
    runtime: RuntimeAdapter
): Operation<Stream<boolean, void>> {
    return resource(function* (provide) {
        const signal = createSignal<boolean, void>();
        const unsubscribe = runtime.connectivity?.subscribe(
            (isConnected) => signal.send(isConnected)
        );
        try {
            yield* provide(signal);
        } finally {
            unsubscribe?.();
            signal.close();
        }
    });
}
