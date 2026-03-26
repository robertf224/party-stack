// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology } from "./types";
import type { LiveOntologyOpts, OntologyAdapter } from "@party-stack/ontology";

export function createIssueTrackerLiveOntology(
    adapter: OntologyAdapter,
    opts?: Pick<LiveOntologyOpts, "getContext">
): LiveOntology<IssueTrackerOntology> {
    return createLiveOntology<IssueTrackerOntology>({
        ir: ontology,
        adapter,
        getContext: opts?.getContext,
    });
}
