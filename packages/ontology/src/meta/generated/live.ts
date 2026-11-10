// Auto-generated file - do not edit manually

import ontology from "@party-stack/ontology-spec/meta";
import { createLiveOntology, type LiveOntologyFactoryOptions, type LiveOntology } from "../../index.js";
import type { MetaOntology, MetaOntologyContext } from "@party-stack/ontology-spec/meta";

export async function createMetaLiveOntology(
    opts: LiveOntologyFactoryOptions<MetaOntologyContext>
): Promise<LiveOntology<MetaOntology>> {
    return createLiveOntology<MetaOntology, MetaOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
