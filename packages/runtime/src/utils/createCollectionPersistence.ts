import type { Coordination } from "@party-stack/coordination";
import { createPersistedCollectionCoordinator } from "../coordinator/createPersistedCollectionCoordinator.js";
import type { PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

/** Use the runtime coordinator while preserving the persistence factory's standard resolvers. */
export function createCollectionPersistence(
    coordination: Coordination,
    persistence: PersistedCollectionPersistence
): PersistedCollectionPersistence {
    const coordinator = createPersistedCollectionCoordinator(coordination, persistence.adapter);
    return {
        ...persistence,
        coordinator,
        resolvePersistenceForCollection: (context) => {
            const resolved = persistence.resolvePersistenceForCollection?.(context) ?? persistence;
            coordinator.setAdapterForCollection?.(context.collectionId, resolved.adapter);
            return { ...resolved, coordinator };
        },
    };
}
