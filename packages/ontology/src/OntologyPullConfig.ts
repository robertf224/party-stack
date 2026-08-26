import type { OntologyIR } from "./ir/generated/types.js";
import type { OntologyBackendAdapter } from "./live/OntologyBackendAdapter.js";

export interface OntologyPullSource<
    Options = unknown,
> {
    createBackend: (
        options: Options
    ) =>
        | OntologyBackendAdapter
        | Promise<OntologyBackendAdapter>;
    transformPulledOntology?: (
        ontology: OntologyIR,
        options: Options
    ) => OntologyIR | Promise<OntologyIR>;
}

export interface OntologyPullConfig<
    Options = unknown,
> {
    source: OntologyPullSource<Options>;
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryFunctionTypeNames?: string[];
    options?: Options;
}
