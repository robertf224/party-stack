import type {
    OntologyIR,
    OntologyMutator,
    OntologyMutatorObjects,
    OntologyMutatorTx,
    OntologyPropertyChange,
} from "@party-stack/ontology";
import type { InitialQueryBuilder } from "@tanstack/db";

/**
 * Structural subset of Foundry's staged-write `WriteableClient`.
 * Generated Foundry clients can be passed directly.
 */
export interface FoundryStagedWriteClient {
    create(
        objectType: unknown,
        object: Record<string, unknown>
    ): Promise<unknown>;
    update(
        object: {
            $apiName: string;
            $primaryKey: string | number;
        },
        changes: Record<string, unknown>
    ): Promise<unknown>;
    delete(object: {
        $apiName: string;
        $primaryKey: string | number;
    }): Promise<unknown>;
    query?<T>(
        build: (
            query: InitialQueryBuilder,
            objects: OntologyMutatorObjects
        ) => unknown
    ): Promise<T>;
}

export interface CreateFoundryStagedWriteMutatorTxOptions {
    client: FoundryStagedWriteClient;
    /**
     * Generated OSDK object type tokens, keyed by ontology API name. Required
     * for creates when the client cannot accept an `$apiName` placeholder.
     */
    objectTypes?: Record<string, unknown>;
}

function setPath(
    object: Record<string, unknown>,
    path: string[],
    value: unknown
): void {
    let target = object;
    for (const segment of path.slice(0, -1)) {
        const existing = target[segment];
        if (
            typeof existing !== "object" ||
            existing === null ||
            Array.isArray(existing)
        ) {
            target[segment] = {};
        }
        target = target[segment] as Record<string, unknown>;
    }
    target[path.at(-1)!] = value;
}

function changesToRecord(
    changes:
        | Record<string, unknown>
        | OntologyPropertyChange[]
): Record<string, unknown> {
    if (!Array.isArray(changes)) return changes;
    const record: Record<string, unknown> = {};
    for (const change of changes) {
        setPath(record, change.path, change.value);
    }
    return record;
}

export function createFoundryStagedWriteMutatorTx(
    options: CreateFoundryStagedWriteMutatorTxOptions
): OntologyMutatorTx {
    return {
        query: async (build) => {
            if (!options.client.query) {
                throw new Error(
                    "Foundry staged-write mutator queries require a query adapter backed by the ambient staged-write client."
                );
            }
            return options.client.query(build);
        },
        mutate: new Proxy(
            {},
            {
                get: (_target, objectType) => {
                    if (typeof objectType !== "string") {
                        return undefined;
                    }
                    return {
                        create: async (
                            object: Record<string, unknown>
                        ) => {
                            await options.client.create(
                                options.objectTypes?.[
                                    objectType
                                ] ?? {
                                    $apiName: objectType,
                                },
                                object
                            );
                        },
                        update: async (
                            key: string | number,
                            changes:
                                | Record<string, unknown>
                                | OntologyPropertyChange[]
                        ) => {
                            await options.client.update(
                                {
                                    $apiName: objectType,
                                    $primaryKey: key,
                                },
                                changesToRecord(changes)
                            );
                        },
                        delete: async (
                            key: string | number
                        ) => {
                            await options.client.delete({
                                $apiName: objectType,
                                $primaryKey: key,
                            });
                        },
                    };
                },
            }
        ) as OntologyMutatorTx["mutate"],
    };
}

/**
 * Run a Party Stack ontology mutator inside Foundry's ambient staged-write
 * transaction. Foundry provides atomic commit/rollback and read-after-write.
 */
export async function runFoundryOntologyMutator(options: {
    ir: OntologyIR;
    client: FoundryStagedWriteClient;
    mutator: OntologyMutator;
    args: Record<string, unknown>;
    context?: Record<string, unknown>;
    objectTypes?: Record<string, unknown>;
}): Promise<void> {
    const tx = createFoundryStagedWriteMutatorTx({
        client: options.client,
        objectTypes: options.objectTypes,
    });
    await options.mutator({
        tx,
        args: options.args,
        context: options.context ?? {},
    });
}
