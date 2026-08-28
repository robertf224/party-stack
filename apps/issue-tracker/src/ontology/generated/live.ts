// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology, IssueTrackerOntologyContext } from "./types";
import type { CreateLiveOntologyOpts } from "@party-stack/ontology";

export async function createIssueTrackerLiveOntology(
    opts: Omit<CreateLiveOntologyOpts<IssueTrackerOntologyContext>, "ir">
): Promise<LiveOntology<IssueTrackerOntology>> {
    return createLiveOntology<IssueTrackerOntology, IssueTrackerOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
