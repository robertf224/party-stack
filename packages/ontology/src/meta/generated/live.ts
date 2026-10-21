// Auto-generated file - do not edit manually

import ontology from "@party-stack/ontology-spec/meta";
import { createLiveOntology, type CreateLiveOntologyOpts, type LiveOntology } from "../../index.js";
import type { MetaOntology, MetaOntologyContext } from "@party-stack/ontology-spec/meta";

export async function createMetaLiveOntology(
    opts: Omit<CreateLiveOntologyOpts<MetaOntologyContext>, "ir">
): Promise<LiveOntology<MetaOntology>> {
    return createLiveOntology<MetaOntology, MetaOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
