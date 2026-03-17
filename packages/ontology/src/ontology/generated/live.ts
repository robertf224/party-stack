// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../ontology.js";
import type { MetaOntology } from "./types.js";
import type { OntologyAdapter } from "../../index.js";

export function createMetaLiveOntology(adapter: OntologyAdapter): LiveOntology<MetaOntology> {
    return createLiveOntology<MetaOntology>({
        ir: ontology,
        adapter,
    });
}
