import {
    eq,
    queryOnce,
    type Collection,
    type Transaction,
} from "@tanstack/db";
import { set } from "lodash-es";
import type {
    OntologyMutatorObjects,
    OntologyMutatorTx,
    OntologyPropertyChange,
    OntologyReadTx,
} from "./types.js";

export function createReadTx(
    objects: OntologyMutatorObjects
): OntologyReadTx {
    return {
        query: (build) =>
            queryOnce((query) =>
                build(query, objects) as never
            ) as never,
    };
}

export function createMutatorTx(options: {
    transaction: Transaction;
    objects: OntologyMutatorObjects;
    primaryKeys?: Record<string, string>;
}): OntologyMutatorTx {
    return {
        ...createReadTx(options.objects),
        mutate: new Proxy(
            {},
            {
                get: (_target, objectType) => {
                    if (typeof objectType !== "string") {
                        return undefined;
                    }
                    const collection =
                        options.objects[objectType];
                    if (!collection) {
                        throw new Error(
                            `Unknown object type "${objectType}".`
                        );
                    }
                    return {
                        create: (
                            object: Record<string, unknown>
                        ) => {
                            options.transaction.mutate(() => {
                                collection.insert(object);
                            });
                            return Promise.resolve();
                        },
                        update: async (
                            key: string | number,
                            changes:
                                | Record<string, unknown>
                                | OntologyPropertyChange[]
                        ) => {
                            await ensureObjectLoaded(
                                collection,
                                objectType,
                                options.primaryKeys,
                                key
                            );
                            options.transaction.mutate(() => {
                                collection.update(key, (draft) => {
                                    applyChanges(
                                        draft as Record<
                                            string,
                                            unknown
                                        >,
                                        changes
                                    );
                                });
                            });
                        },
                        delete: async (
                            key: string | number
                        ) => {
                            await ensureObjectLoaded(
                                collection,
                                objectType,
                                options.primaryKeys,
                                key
                            );
                            options.transaction.mutate(() => {
                                collection.delete(key);
                            });
                        },
                    };
                },
            }
        ) as OntologyMutatorTx["mutate"],
    };
}

async function ensureObjectLoaded(
    collection: Collection<
        Record<string, unknown>,
        string | number
    >,
    objectType: string,
    primaryKeys: Record<string, string> | undefined,
    key: string | number
): Promise<void> {
    if (collection.has(key)) return;
    const primaryKey = primaryKeys?.[objectType];
    if (!primaryKey) return;

    await queryOnce((query) =>
        query
            .from({ object: collection })
            .where(({ object }) =>
                eq(
                    object[primaryKey],
                    key
                )
            )
            .findOne()
    );
}

function applyChanges(
    object: Record<string, unknown>,
    changes:
        | Record<string, unknown>
        | OntologyPropertyChange[]
): void {
    if (Array.isArray(changes)) {
        for (const change of changes) {
            set(object, change.path, change.value);
        }
    } else {
        Object.assign(object, changes);
    }
}
