import { createCollection, localOnlyCollectionOptions, type Collection } from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { createPersistedCollectionCoordinator } from "../coordinator/createPersistedCollectionCoordinator.js";
import type { RuntimeAdapter } from "../types.js";

export function createLocalCollection<T extends object, TKey extends string | number>(options: {
    name: string;
    getKey: (value: T) => TKey;
    runtime: RuntimeAdapter;
    schemaVersion?: number;
}): Collection<T, TKey> {
    const collectionOptions = {
        id: `party-stack:${options.runtime.owner}:${options.runtime.namespace}:${options.name}`,
        getKey: options.getKey,
    };
    const persistence = options.runtime.persistence;

    return createCollection(
        persistence
            ? persistedCollectionOptions<T, TKey>({
                  ...collectionOptions,
                  schemaVersion: options.schemaVersion,
                  persistence: {
                      adapter: persistence,
                      coordinator: createPersistedCollectionCoordinator(
                          options.runtime.coordination,
                          persistence
                      ),
                  },
              })
            : localOnlyCollectionOptions<T, TKey>(collectionOptions)
    );
}
