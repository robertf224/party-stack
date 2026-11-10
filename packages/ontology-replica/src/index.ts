import { Context, Effect, Layer } from "effect";
import { makeReplica } from "./make.js";
import { ReplicaUpstream } from "./upstream.js";
import type { ReplicaService } from "./service.js";
export type {
    ReplicaAttachments,
    AttachmentCreateOptions,
    AttachmentCreation,
} from "./attachments/service.js";
export { makeReplica } from "./make.js";
export type { ReplicaOptions } from "./make.js";
export type {
    ReplicaService,
    ReplicaConfiguration,
    ReplicaReads,
    ReplicaOutbox,
    ReplicaActionStatus,
    ReplicaOutboxPolicy,
    ReplicaPinControls,
} from "./service.js";
import type { ReplicaOptions } from "./make.js";
export { ReplicaStatusSchema, makeReplicaMonitor } from "./status.js";
export type { ReplicaStatus, ReplicaLoad, ReplicaMonitor } from "./status.js";
export type { PinOptions, PinStatus, PinGraph } from "./pins.js";
export { PinOptionsSchema, PinStatusSchema } from "./pins.js";
export { pinOntology, pinMutators, pinRecordKey, pinDefinitionKey } from "./pinModel.js";
export type { PinWrite, PinRecord, PinUpdate } from "./pinModel.js";
export type { ReplicaPins } from "./pinManager.js";
export type { DemandPolicy, DemandRefreshPolicy } from "./demandCache.js";
export { ReplicaUpstream } from "./upstream.js";
export type { ReplicaUpstreamService } from "./upstream.js";
export type {
    ActionWaitOptions,
    ObjectCacheSweepOptions,
    ObjectCacheGcPolicy,
    ObjectCachePolicy,
} from "./policies.js";
export type { PendingAction } from "@party-stack/ontology-backend/protocol";
export class Replica extends Context.Service<Replica, ReplicaService>()(
    "@party-stack/ontology-replica/Replica"
) {
    static readonly layer = (options: Omit<ReplicaOptions, "backend" | "source" | "authentication">) =>
        Layer.effect(
            Replica,
            Effect.gen(function* () {
                const upstream = yield* ReplicaUpstream;
                return yield* makeReplica({
                    ...options,
                    backend: upstream.backend,
                    source: upstream.kind === "speculative" ? upstream.source : undefined,
                    authentication: upstream.authentication,
                });
            })
        );
}
