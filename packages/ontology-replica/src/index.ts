import { Context, Effect, Layer } from "effect";
import { makeReplicaHost } from "./host.js";
import { kernel } from "./internal.js";
import { replicaStateSource as stateSource, connectReplicaParent as connectParent } from "./parent.js";
import { makeCachedProxy as cachedProxy } from "./proxy.js";
import { ReplicaUpstream } from "./upstream.js";
import type { ReplicaService } from "./service.js";
export { makeReplica } from "./service.js";
export type { ReplicaService, ReplicaOptions } from "./service.js";
import type { ReplicaHostOptions } from "./host.js";
export { ReplicaStatusSchema, makeReplicaMonitor } from "./status.js";
export type { ReplicaStatus, ReplicaLoad, ReplicaMonitor } from "./status.js";
export type { DemandPolicy } from "./demandCache.js";
export { ReplicaUpstream } from "./upstream.js";
export type { ReplicaUpstreamService } from "./upstream.js";
export type {
    ActionWaitOptions,
    ReplicaOutboxPolicy,
    ObjectCacheSweepOptions,
    ObjectCacheGcPolicy,
} from "./engine.js";
export { ClientTokenSchema, ClientSessionSchema } from "@party-stack/ontology-backend/clients";
export type {
    ClientLease,
    ClientSession,
    ClientToken,
    ClientPolicy,
} from "@party-stack/ontology-backend/clients";
export type {
    ClientState,
    ClientSubmission,
    ClientView,
    OntologySource,
    PendingAction,
    ReplicaStateSnapshot,
    StateSelection,
} from "@party-stack/ontology-backend/protocol";
export type { ParentConnection } from "./parent.js";
export class Replica extends Context.Service<Replica, ReplicaService>()(
    "@party-stack/ontology-replica/Replica"
) {
    static readonly layer = (options: Omit<ReplicaHostOptions, "backend" | "source" | "connection">) =>
        Layer.effect(
            Replica,
            Effect.gen(function* () {
                const upstream = yield* ReplicaUpstream;
                const host = yield* makeReplicaHost({
                    ...options,
                    backend: upstream.backend,
                    source: upstream.kind === "speculative" ? upstream.source : undefined,
                    connection: upstream.connection,
                });
                return host.replica;
            })
        );
}
export const replicaStateSource = (replica: ReplicaService) => stateSource(replica[kernel]);
export const connectReplicaParent = (
    child: ReplicaService,
    ...args: Parameters<typeof connectParent> extends [unknown, ...infer Rest] ? Rest : never
) => connectParent(child[kernel], ...args);
export const makeCachedProxy = (
    options: Omit<Parameters<typeof cachedProxy>[0], "replica"> & { readonly replica: ReplicaService }
) => cachedProxy({ ...options, replica: options.replica[kernel] });
