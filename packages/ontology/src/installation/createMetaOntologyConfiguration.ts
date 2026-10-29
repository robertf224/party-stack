import metaOntology from "@party-stack/ontology-spec/meta";
import { createLocalMetaOntologyBackendAdapter } from "../meta/createLocalMetaOntologyBackendAdapter.js";
import type { OntologyConfiguration } from "./types.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

export type MetaOntologyConfigurationOptions = Omit<OntologyConfiguration, "ir"> | { ir: OntologyIR };

export function createMetaOntologyConfiguration(
    options: MetaOntologyConfigurationOptions
): OntologyConfiguration {
    return {
        ...("ir" in options
            ? {
                  backend: () => createLocalMetaOntologyBackendAdapter(options.ir),
              }
            : options),
        ir: metaOntology,
    };
}
