// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology } from "./types";
import type { CreateLiveOntologyOpts } from "@party-stack/ontology";

export async function createIssueTrackerLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: Omit<CreateLiveOntologyOpts<Context>, "ir">): Promise<LiveOntology<IssueTrackerOntology>> {
    return createLiveOntology<IssueTrackerOntology, Context>({
        ...opts,
        ir: ontology,
    });
}
