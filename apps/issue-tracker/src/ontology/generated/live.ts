// Auto-generated file - do not edit manually

import { createLiveOntology, type CreateLiveOntologyOpts, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology, IssueTrackerOntologyContext } from "./types";

export async function createIssueTrackerLiveOntology(
    opts: Omit<CreateLiveOntologyOpts<IssueTrackerOntologyContext>, "ir">
): Promise<LiveOntology<IssueTrackerOntology>> {
    return createLiveOntology<IssueTrackerOntology, IssueTrackerOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
