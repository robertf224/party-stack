/** Trusted composition surface. This is not an authorization boundary. */
export { replicaController } from "./internal.js";
export type { ReplicaService as ReplicaController } from "./engine.js";
export type { ParentConnection } from "./parent.js";
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
    ReplicaStateSnapshot,
    StateSelection,
} from "@party-stack/ontology-backend/protocol";
import { replicaController } from "./internal.js";
import { replicaStateSource as stateSource, connectReplicaParent as connectParent } from "./parent.js";
import { makeCachedProxy as cachedProxy } from "./proxy.js";
import type { ReplicaService } from "./service.js";
export const replicaStateSource = (replica: ReplicaService) => stateSource(replicaController(replica));
export const connectReplicaParent = (
    child: ReplicaService,
    ...args: Parameters<typeof connectParent> extends [unknown, ...infer Rest] ? Rest : never
) => connectParent(replicaController(child), ...args);
export const makeCachedProxy = (
    options: Omit<Parameters<typeof cachedProxy>[0], "replica"> & { readonly replica: ReplicaService }
) => cachedProxy({ ...options, replica: replicaController(options.replica) });
