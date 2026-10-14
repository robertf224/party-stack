// Auto-generated file - do not edit manually

import { createLiveOntology, type CreateLiveOntologyOpts, type LiveOntology } from "../../index.js";
import ontology from "../ontology.js";
import type { MetaOntology, MetaOntologyContext } from "./types.js";

export async function createMetaLiveOntology(
    opts: Omit<CreateLiveOntologyOpts<MetaOntologyContext>, "ir">
): Promise<LiveOntology<MetaOntology>> {
    return createLiveOntology<MetaOntology, MetaOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
