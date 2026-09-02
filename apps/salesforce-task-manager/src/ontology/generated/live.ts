// Auto-generated file - do not edit manually

import { createLiveOntology, type CreateLiveOntologyOpts, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology.js";
import type { SalesforceTaskManagerOntology, SalesforceTaskManagerOntologyContext } from "./types.js";

export async function createSalesforceTaskManagerLiveOntology(
    opts: Omit<CreateLiveOntologyOpts<SalesforceTaskManagerOntologyContext>, "ir">
): Promise<LiveOntology<SalesforceTaskManagerOntology>> {
    return createLiveOntology<SalesforceTaskManagerOntology, SalesforceTaskManagerOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
