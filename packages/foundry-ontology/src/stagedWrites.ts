import { resolveType } from "@party-stack/ontology-spec/utils";
import { Predicate, Schema } from "effect";
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
    create(objectType: unknown, object: Record<string, unknown>): Promise<unknown>;
    update(
        object: {
            $apiName: string;
            $primaryKey: string | number;
        },
        changes: Record<string, unknown>
    ): Promise<unknown>;
    delete(object: { $apiName: string; $primaryKey: string | number }): Promise<unknown>;
    query?<T>(build: (query: InitialQueryBuilder, objects: OntologyMutatorObjects) => unknown): Promise<T>;
}

export interface CreateFoundryStagedWriteMutatorTxOptions {
    ir: OntologyIR;
    client: FoundryStagedWriteClient;
    /**
     * Generated OSDK object type tokens, keyed by ontology API name. Required
     * for creates when the client cannot accept an `$apiName` placeholder.
     */
    objectTypes?: Record<string, unknown>;
}

function setPath(object: Record<string, unknown>, path: string[], value: unknown): void {
    let target = object;
    for (const segment of path.slice(0, -1)) {
        const existing = target[segment];
        if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
            target[segment] = {};
        }
        target = target[segment] as Record<string, unknown>;
    }
    target[path.at(-1)!] = value;
}

function changesToRecord(
    changes: Record<string, unknown> | OntologyPropertyChange[]
): Record<string, unknown> {
    if (!Array.isArray(changes)) return changes;
    const record: Record<string, unknown> = {};
    for (const change of changes) {
        setPath(record, change.path, change.value);
    }
    return record;
}

const CiphertextHandle = Schema.Struct({
    ciphertext: Schema.String.check(Schema.isPattern(/^CIPHER::[^:]+::.+::CIPHER$/u)),
});

/** Foundry v2 accepts {plaintext} for new secrets and {ciphertext} for a copied value.
 * Encryption happens in the ambient Foundry transaction, never in the wrapper's query path.
 */
function writeProperties(
    ir: OntologyIR,
    objectType: string,
    values: Record<string, unknown>
): Record<string, unknown> {
    const definition = ir.objectTypes.find((object) => object.name === objectType);
    const result = { ...values };
    for (const property of definition?.properties ?? []) {
        if (!Object.hasOwn(values, property.name)) continue;
        let type = resolveType(ir, property.type);
        while (type.kind === "optional") type = resolveType(ir, type.value.type);
        if (type.kind !== "encrypted") continue;
        const value = values[property.name];
        if (value === undefined) continue;
        if (typeof value === "string") result[property.name] = { plaintext: value };
        else if (Predicate.hasProperty(value, "decrypt") && Predicate.isFunction(value.decrypt)) {
            // Real OSDK CipherText objects are normalized by WriteableClient itself; never applyAction decrypt.
            result[property.name] = value;
        } else {
            // Portable handles are not OSDK CipherText instances; convert them explicitly.
            const parsed = Schema.decodeUnknownOption(CiphertextHandle)(value);
            if (parsed._tag === "Some") result[property.name] = { ciphertext: parsed.value.ciphertext };
            else
                throw new TypeError(
                    "Expected plaintext or a Foundry encrypted handle for an encrypted property."
                );
        }
    }
    return result;
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
                        create: async (object: Record<string, unknown>) => {
                            await options.client.create(
                                options.objectTypes?.[objectType] ?? {
                                    $apiName: objectType,
                                },
                                writeProperties(options.ir, objectType, object)
                            );
                        },
                        update: async (
                            key: string | number,
                            changes: Record<string, unknown> | OntologyPropertyChange[]
                        ) => {
                            await options.client.update(
                                {
                                    $apiName: objectType,
                                    $primaryKey: key,
                                },
                                writeProperties(options.ir, objectType, changesToRecord(changes))
                            );
                        },
                        delete: async (key: string | number) => {
                            await options.client.delete({
                                $apiName: objectType,
                                $primaryKey: key,
                            });
                        },
                    };
                },
            }
        ),
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
        ir: options.ir,
        client: options.client,
        objectTypes: options.objectTypes,
    });
    await options.mutator({
        tx,
        args: options.args,
        context: options.context ?? {},
    });
}
