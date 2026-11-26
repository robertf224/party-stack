import type { ReplicaService } from "./engine.js";
import type { ReplicaService as PublicReplica } from "./service.js";
/** Infrastructure composition only; never serialized or used as an authorization boundary. */
export const kernel = Symbol("Replica.kernel");
/** The backend the replica's current engine syncs with. */
export const upstream = Symbol("Replica.upstream");
export interface ReplicaHandle {
    readonly [kernel]: ReplicaService;
}

export const replicaController = (replica: PublicReplica): ReplicaService =>
    (replica as unknown as ReplicaHandle)[kernel];

/** The backend the replica's current engine syncs with, when it has one. A replica that
 * follows its definition may build a new backend for each definition. */
export const replicaBackend = (replica: PublicReplica) =>
    (
        replica as unknown as {
            readonly [upstream]?: import("@party-stack/ontology-backend").OntologyBackendService;
        }
    )[upstream];

/** Signals, from outside the metadata, that a dynamic definition may have changed (for example a
 * newer description from the server the replica is fed by). The replica revalidates its metadata. */
export const definitionHints = Symbol("Replica.definitionHints");
