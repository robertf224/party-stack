import type { OntologyBackendAdapter } from "./live/OntologyBackendAdapter.js";

export interface OntologyConfigAdapter<Opts = unknown> {
    createAdapter: (opts: Opts) => OntologyBackendAdapter | Promise<OntologyBackendAdapter>;
}

export interface OntologyConfig<Opts = unknown> {
    adapter: OntologyConfigAdapter<Opts>;
    objectTypeNames: string[];
    actionTypeNames: string[];
    queryFunctionTypeNames?: string[];
    opts?: Opts;
}
