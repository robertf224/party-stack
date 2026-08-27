import metaOntology from "../meta/ontology.js";
import type { OntologyConfiguration } from "./types.js";

export type MetaOntologyConfigurationOptions = Omit<OntologyConfiguration, "ir">;

export function createMetaOntologyConfiguration(
    options: MetaOntologyConfigurationOptions
): OntologyConfiguration {
    return {
        ...options,
        ir: metaOntology,
    };
}
