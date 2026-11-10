// Auto-generated file - do not edit manually

import {
    createLiveOntology,
    type LiveOntologyFactoryOptions,
    type LiveOntology,
} from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology, IssueTrackerOntologyContext } from "./types";

export async function createIssueTrackerLiveOntology(
    opts: LiveOntologyFactoryOptions<IssueTrackerOntologyContext>
): Promise<LiveOntology<IssueTrackerOntology>> {
    return createLiveOntology<IssueTrackerOntology, IssueTrackerOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
