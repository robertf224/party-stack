import { Effect } from "effect";
import type { OntologyRpcServerOptions } from "./rpc.js";

/** Internal commands can inspect or change state outside the caller's IR policy.
 * Policy/context binding remain enforced. Without a policy, exposes raw capabilities.
 */
export type OntologyInternalAccess = true | ((context: Record<string, unknown>) => boolean);

/** Adds internal commands without changing domain permissions or exposing raw replication. */
export const withInternalCommands =
    <R>(
        authorize: OntologyRpcServerOptions<R>["authorize"],
        enabled: boolean
    ): OntologyRpcServerOptions<R>["authorize"] =>
    (request, headers) =>
        enabled &&
        [
            "ReplicaStatus",
            "Traces",
            "ControlOutbox",
            "ReadPin",
            "WatchPin",
            "SetPin",
            "ClearPin",
            "DeleteLocalData",
            "ReleaseOwner",
        ].includes(request.operation)
            ? Effect.void
            : authorize(request, headers);
