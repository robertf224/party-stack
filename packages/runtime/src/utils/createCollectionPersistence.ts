import type { Coordination } from "@party-stack/coordination";
import { createPersistedCollectionCoordinator } from "../coordinator/createPersistedCollectionCoordinator.js";

import type { RuntimePersistenceAdapter } from "../types.js";
import type {
    PersistedCollectionPersistence,
    PersistenceAdapter,
} from "@tanstack/db-sqlite-persistence-core";

/** Forward the collection's schema and mode to adapters that support collection scoping. */
export function createCollectionPersistence(
    coordination: Coordination,
    adapter: PersistenceAdapter
): PersistedCollectionPersistence {
    const coordinator = createPersistedCollectionCoordinator(coordination, adapter);
    const scoped = adapter as RuntimePersistenceAdapter;
    return {
        adapter,
        coordinator,
        resolvePersistenceForCollection: scoped.forCollection
            ? (context) => {
                  const resolved = scoped.forCollection!(context);
                  coordinator.setAdapterForCollection?.(context.collectionId, resolved);
                  return { adapter: resolved, coordinator };
              }
            : undefined,
    };
}
