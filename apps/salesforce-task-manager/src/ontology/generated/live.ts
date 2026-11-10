// Auto-generated file - do not edit manually

import {
    createLiveOntology,
    type LiveOntologyFactoryOptions,
    type LiveOntology,
} from "@party-stack/ontology";
import ontology from "../ontology";
import type { SalesforceTaskManagerOntology, SalesforceTaskManagerOntologyContext } from "./types";

export async function createSalesforceTaskManagerLiveOntology(
    opts: LiveOntologyFactoryOptions<SalesforceTaskManagerOntologyContext>
): Promise<LiveOntology<SalesforceTaskManagerOntology>> {
    return createLiveOntology<SalesforceTaskManagerOntology, SalesforceTaskManagerOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
