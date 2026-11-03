import { Context, Effect, Layer } from "effect";
import { makeReplicaHost } from "./host.js";
import { ReplicaUpstream } from "./upstream.js";
import type { ReplicaService } from "./service.js";
export type {
    ReplicaAttachments,
    AttachmentCreateOptions,
    AttachmentCreation,
} from "./attachments/service.js";
export { makeReplica } from "./service.js";
export type {
    ReplicaService,
    ReplicaOptions,
    ReplicaConfiguration,
    ReplicaReads,
    ReplicaOutbox,
    ReplicaActionStatus,
    ReplicaOutboxPolicy,
} from "./service.js";
import type { ReplicaHostOptions } from "./host.js";
export { ReplicaStatusSchema, makeReplicaMonitor } from "./status.js";
export type { ReplicaStatus, ReplicaLoad, ReplicaMonitor } from "./status.js";
export type { PinOptions, PinStatus } from "./pins.js";
export type { DemandPolicy, DemandRefreshPolicy } from "./demandCache.js";
export { ReplicaUpstream } from "./upstream.js";
export type { ReplicaUpstreamService } from "./upstream.js";
export type { ActionWaitOptions, ObjectCacheSweepOptions, ObjectCacheGcPolicy } from "./policies.js";
export type { PendingAction } from "@party-stack/ontology-backend/protocol";
export class Replica extends Context.Service<Replica, ReplicaService>()(
    "@party-stack/ontology-replica/Replica"
) {
    static readonly layer = (options: Omit<ReplicaHostOptions, "backend" | "source" | "authentication">) =>
        Layer.effect(
            Replica,
            Effect.gen(function* () {
                const upstream = yield* ReplicaUpstream;
                const host = yield* makeReplicaHost({
                    ...options,
                    backend: upstream.backend,
                    source: upstream.kind === "speculative" ? upstream.source : undefined,
                    authentication: upstream.authentication,
                });
                return host.replica;
            })
        );
}
