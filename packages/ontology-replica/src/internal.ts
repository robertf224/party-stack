import type { ReplicaService } from "./engine.js";
/** Infrastructure composition only; never serialized or used as an authorization boundary. */
export const kernel = Symbol("Replica.kernel");
export interface ReplicaHandle {
    readonly [kernel]: ReplicaService;
}
