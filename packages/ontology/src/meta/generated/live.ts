// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../ontology.js";
import type { MetaOntology } from "./types.js";
import type { CreateLiveOntologyOpts } from "../../index.js";

export async function createMetaLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: Omit<CreateLiveOntologyOpts<Context>, "ir">): Promise<LiveOntology<MetaOntology>> {
    return createLiveOntology<MetaOntology, Context>({
        ...opts,
        ir: ontology,
    });
}
