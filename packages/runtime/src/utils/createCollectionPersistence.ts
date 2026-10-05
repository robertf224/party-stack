import type { Coordination } from "@party-stack/coordination";
import { createPersistedCollectionCoordinator } from "../coordinator/createPersistedCollectionCoordinator.js";
import type {
    PersistedCollectionPersistence,
    PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

/** Use the runtime coordinator while preserving the persistence factory's standard resolvers. */
export function createCollectionPersistence(
    coordination: Coordination,
    persistence: PersistenceAdapter | PersistedCollectionPersistence
): PersistedCollectionPersistence {
    const source: PersistedCollectionPersistence =
        "adapter" in persistence ? persistence : { adapter: persistence };
    const coordinator = createPersistedCollectionCoordinator(coordination, source.adapter);
    return {
        ...source,
        coordinator,
        resolvePersistenceForCollection: (context) => {
            const resolved =
                source.resolvePersistenceForCollection?.(context) ??
                source.resolvePersistenceForMode?.(context.mode) ??
                source;
            coordinator.setAdapterForCollection?.(context.collectionId, resolved.adapter);
            return { ...resolved, coordinator };
        },
    };
}
