import { Effect } from "effect";
import { Runtime } from "../Runtime.js";
import type { RuntimeAdapter, RuntimeAdapterProvider, RuntimeAcquisitionError } from "../types.js";

/** Define a scoped runtime provider from platform capabilities. Acquisition is lazy. */
export function defineRuntime(
    provider: (
        owner: string,
        namespace: string
    ) => RuntimeAdapter | Effect.Effect<RuntimeAdapter, RuntimeAcquisitionError, import("effect").Scope.Scope>
): RuntimeAdapterProvider {
    return (owner, namespace) =>
        Effect.suspend(() => {
            const capabilities = provider(owner, namespace);
            return Effect.isEffect(capabilities)
                ? Effect.flatMap(capabilities, Runtime.make)
                : Runtime.make(capabilities);
        });
}
