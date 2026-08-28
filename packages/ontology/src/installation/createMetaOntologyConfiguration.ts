import { createLocalMetaOntologyBackendAdapter } from "../meta/createLocalMetaOntologyBackendAdapter.js";
import metaOntology from "../meta/ontology.js";
import type { OntologyConfiguration } from "./types.js";
import type { OntologyIR } from "../ir/index.js";

export type MetaOntologyConfigurationOptions = Omit<OntologyConfiguration, "ir"> | { ir: OntologyIR };

export function createMetaOntologyConfiguration(
    options: MetaOntologyConfigurationOptions
): OntologyConfiguration {
    return {
        ...("ir" in options
            ? {
                  backend: () => createLocalMetaOntologyBackendAdapter(options.ir),
                  persistObjects: false,
              }
            : options),
        ir: metaOntology,
    };
}
