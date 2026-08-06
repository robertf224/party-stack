import type { OntologyIR } from "./ir/generated/types.js";
import type { OntologyBackendAdapter } from "./live/OntologyBackendAdapter.js";

export interface OntologyConfigAdapter<Opts = unknown> {
    createAdapter: (opts: Opts) => OntologyBackendAdapter | Promise<OntologyBackendAdapter>;
    transformOntology?: (
        ontology: OntologyIR,
        opts: Opts
    ) => OntologyIR | Promise<OntologyIR>;
}

export interface OntologyConfig<Opts = unknown> {
    adapter: OntologyConfigAdapter<Opts>;
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryFunctionTypeNames?: string[];
    opts?: Opts;
}
