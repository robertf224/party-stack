import { eq, queryOnce, type Collection, type Transaction } from "@tanstack/db";
import { setAtPath } from "../../utils/paths.js";
import type {
    OntologyMutatorObjects,
    OntologyMutatorTx,
    OntologyPropertyChange,
    OntologyReadTx,
} from "./types.js";

export function createReadTx(objects: OntologyMutatorObjects): OntologyReadTx {
    return { query: (build) => queryOnce((query) => build(query, objects) as never) };
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
                    const collection = options.objects[objectType];
                    if (!collection) {
                        throw new Error(`Unknown object type "${objectType}".`);
                    }
                    return {
                        create: (object: Record<string, unknown>) => {
                            options.transaction.mutate(() => {
                                collection.insert(object);
                            });
                            return Promise.resolve();
                        },
                        update: async (
                            key: string | number,
                            changes: Record<string, unknown> | OntologyPropertyChange[]
                        ) => {
                            await ensureObjectLoaded(collection, objectType, options.primaryKeys, key);
                            options.transaction.mutate(() => {
                                collection.update(key, (draft) => {
                                    applyChanges(draft, changes);
                                });
                            });
                        },
                        delete: async (key: string | number) => {
                            await ensureObjectLoaded(collection, objectType, options.primaryKeys, key);
                            options.transaction.mutate(() => {
                                collection.delete(key);
                            });
                        },
                    };
                },
            }
        ),
    };
}

async function ensureObjectLoaded(
    collection: Collection<Record<string, unknown>, string | number>,
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
            .where(({ object }) => eq(object[primaryKey], key))
            .findOne()
    );
}

function applyChanges(
    object: Record<string, unknown>,
    changes: Record<string, unknown> | OntologyPropertyChange[]
): void {
    if (Array.isArray(changes)) {
        let updated = { ...object };
        const changedProperties = new Set<string>();
        for (const change of changes) {
            const [property] = change.path;
            if (property === undefined) {
                throw new Error("Ontology property change paths must not be empty.");
            }
            updated = setAtPath(updated, change.path, change.value);
            changedProperties.add(property);
        }
        for (const property of changedProperties) {
            object[property] = updated[property];
        }
    } else {
        Object.assign(object, changes);
    }
}
