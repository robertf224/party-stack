import type { OntologyAdapter } from "./OntologyAdapter.js";

export interface OntologyAdapterModule<TConfig = unknown> {
    createAdapter: (config: TConfig) => OntologyAdapter | Promise<OntologyAdapter>;
}

export interface OntologyConfig<TConfig = unknown> {
    adapter: OntologyAdapterModule<TConfig>;
    objectTypeNames: string[];
    config: TConfig;
}
