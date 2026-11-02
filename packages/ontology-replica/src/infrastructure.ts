/** Server composition adapters; authorization belongs to the enclosing server. */
import { replicaController } from "./internal.js";
import { replicaStateSource as stateSource } from "./parent.js";
import { makeCachedProxy as cachedProxy } from "./proxy.js";
import type { ReplicaService } from "./service.js";
export const replicaStateSource = (replica: ReplicaService) => ({
    ...stateSource(replicaController(replica)),
    outbox: replica.outbox,
});
export const makeCachedProxy = (
    options: Omit<Parameters<typeof cachedProxy>[0], "replica"> & { readonly replica: ReplicaService }
) => cachedProxy({ ...options, replica: replicaController(options.replica) });
