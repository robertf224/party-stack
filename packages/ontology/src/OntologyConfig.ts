import type { OntologyAdapter } from "./live/OntologyAdapter.js";

export interface OntologyConfigAdapter<Opts = unknown> {
    createAdapter: (opts: Opts) => OntologyAdapter | Promise<OntologyAdapter>;
}

export interface OntologyConfig<Opts = unknown> {
    adapter: OntologyConfigAdapter<Opts>;
    objectTypeNames: string[];
    actionTypeNames: string[];
    opts?: Opts;
}
