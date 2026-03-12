// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology } from "./types";
import type { OntologyAdapter } from "@party-stack/ontology";

export function createIssueTrackerLiveOntology(adapter: OntologyAdapter): LiveOntology<IssueTrackerOntology> {
    return createLiveOntology<IssueTrackerOntology>({
        ir: ontology,
        adapter,
    });
}
