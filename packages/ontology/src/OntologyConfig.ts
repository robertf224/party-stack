import type { OntologyAdapter } from "./OntologyAdapter.js";

export interface OntologyConfigAdapter<Opts = unknown> {
    createAdapter: (opts: Opts) => OntologyAdapter | Promise<OntologyAdapter>;
}

export interface OntologyConfig<Opts = unknown> {
    adapter: OntologyConfigAdapter<Opts>;
    objectTypeNames: string[];
    opts?: Opts;
}
