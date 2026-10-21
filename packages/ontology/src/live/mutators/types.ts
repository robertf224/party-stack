import type { OntologyObject } from "@party-stack/ontology-spec";
import type { Collection, InitialQueryBuilder } from "@tanstack/db";

export interface OntologyPropertyChange {
    path: string[];
    value: unknown;
}

export type OntologyMutatorObjects = Record<string, Collection<OntologyObject>>;

/** Prepare only the local sources required by a transaction query or keyed edit. */
export type PrepareTransactionSources = (
    types: readonly string[],
    request?: { readonly key?: string | number; readonly plan?: unknown }
) => Promise<void>;

export interface OntologyReadTx {
    query<T>(build: (query: InitialQueryBuilder, objects: OntologyMutatorObjects) => unknown): Promise<T>;
}

export interface OntologyMutatorTx extends OntologyReadTx {
    mutate: Record<
        string,
        {
            create(object: Record<string, unknown>): Promise<void>;
            update(
                key: string | number,
                changes: Record<string, unknown> | OntologyPropertyChange[]
            ): Promise<void>;
            delete(key: string | number): Promise<void>;
        }
    >;
}

export type OntologyMutator = (options: {
    tx: OntologyMutatorTx;
    args: Record<string, unknown>;
    context: Record<string, unknown>;
}) => void | Promise<void>;

export type OntologyMutatorRegistry = Record<string, OntologyMutator>;

export type OntologyQueryFunctionHandler = (options: {
    tx: OntologyReadTx;
    args: Record<string, unknown>;
    context: Record<string, unknown>;
}) => unknown;

export type OntologyQueryFunctionRegistry = Record<string, OntologyQueryFunctionHandler>;
