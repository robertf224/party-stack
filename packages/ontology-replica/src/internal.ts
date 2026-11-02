import type { ReplicaService } from "./engine.js";
import type { ReplicaService as PublicReplica } from "./service.js";
/** Infrastructure composition only; never serialized or used as an authorization boundary. */
export const kernel = Symbol("Replica.kernel");
export interface ReplicaHandle {
    readonly [kernel]: ReplicaService;
}

export const replicaController = (replica: PublicReplica): ReplicaService =>
    (replica as unknown as ReplicaHandle)[kernel];
