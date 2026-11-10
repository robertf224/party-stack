/** Server composition adapters; authorization belongs to the enclosing server. */
import { kernel, replicaController } from "./internal.js";
import { replicaStateSource as stateSource } from "./parent.js";
import { makeCachedProxy as cachedProxy } from "./proxy.js";
import type { ReplicaHandle } from "./internal.js";
import type { ReplicaService } from "./service.js";
/** A local observation may be reused only after it represents at least this
 * replica-owned visible revision. This does not establish upstream coverage.
 * Custom ReplicaService implementations have no native fence and retain
 * independent observations.
 */
export const readVisibleRevision = (replica: ReplicaService) =>
    (replica as ReplicaService & Partial<ReplicaHandle>)[kernel]?.readVisibleRevision;
export const replicaStateSource = (replica: ReplicaService) => ({
    ...stateSource(replicaController(replica)),
    outbox: replica.outbox,
});
export const makeCachedProxy = (
    options: Omit<Parameters<typeof cachedProxy>[0], "replica" | "context"> & {
        readonly replica: ReplicaService;
    }
) =>
    cachedProxy({
        ...options,
        context: options.replica.context,
        replica: replicaController(options.replica),
    });
