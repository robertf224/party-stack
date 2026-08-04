import type { OntologyIR } from "../ir/index.js";
import type {
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
    OntologyCollectionOptions,
} from "../live/OntologyBackendAdapter.js";
import type { SyncConfig } from "@tanstack/db";

export interface CreateStaticMetaOntologyBackendAdapterOptions {
    ir: OntologyIR;
    name?: string;
}

function createStaticCollectionOptions(
    rows: Array<Record<string, unknown>>
): OntologyCollectionOptions {
    const sync: SyncConfig<Record<string, unknown>, string | number> = {
        sync: ({ begin, write, commit, markReady }) => {
            begin();
            for (const row of rows) {
                write({ type: "insert", value: row });
            }
            commit();
            markReady();
            return {
                loadSubset: () => true,
                cleanup: () => {},
            };
        },
    };

    return {
        syncMode: "eager",
        startSync: true,
        sync,
    };
}

/**
 * Creates a read-only meta ontology backend from an existing {@link OntologyIR}.
 *
 * The resulting adapter exposes the same meta collections as the Foundry meta backend
 * (`ObjectType`, `LinkType`, `ValueType`, `ActionType`, `QueryFunctionType`) so local and
 * Foundry deployments can share `createMetaLiveOntology` + `pull()` code paths.
 */
export function createStaticMetaOntologyBackendAdapter(
    opts: CreateStaticMetaOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    const collections: Record<string, OntologyCollectionOptions> = {
        ObjectType: createStaticCollectionOptions(opts.ir.objectTypes as Array<Record<string, unknown>>),
        LinkType: createStaticCollectionOptions(opts.ir.linkTypes as Array<Record<string, unknown>>),
        ValueType: createStaticCollectionOptions(opts.ir.types as Array<Record<string, unknown>>),
        ActionType: createStaticCollectionOptions(opts.ir.actionTypes as Array<Record<string, unknown>>),
        QueryFunctionType: createStaticCollectionOptions(
            opts.ir.queryFunctionTypes as Array<Record<string, unknown>>
        ),
    };

    return {
        name: opts.name ?? "static-metadata",
        getCollectionOptions: (objectType) => {
            const options = collections[objectType];
            if (!options) {
                throw new Error(`Unsupported static metadata object type "${objectType}".`);
            }
            return options;
        },
        applyAction: () => {
            return Promise.reject(new Error("Static meta ontology backends are read-only."));
        },
        runQueryFunction: () => {
            return Promise.reject(new Error("Static meta ontology backends are read-only."));
        },
    };
}

export type CreateStaticMetaOntologyBackendOptions = {
    ir: OntologyIR;
    name?: string;
};

/**
 * Provider form of {@link createStaticMetaOntologyBackendAdapter} for use with
 * `createMetaLiveOntology({ backend })`. The provider IR (meta schema) is ignored;
 * collections are populated from the supplied data IR.
 */
export function createStaticMetaOntologyBackend(
    opts: CreateStaticMetaOntologyBackendOptions
): OntologyBackendAdapterProvider {
    return () => createStaticMetaOntologyBackendAdapter(opts);
}
