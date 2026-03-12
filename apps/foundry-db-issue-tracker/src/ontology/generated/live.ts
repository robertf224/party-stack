// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology/runtime";
import ontology from "../ontology";
import type { FoundryDbIssueTrackerOntology } from "./types.js";
import type { OntologyAdapter } from "@party-stack/ontology/runtime";

export function createFoundryDbIssueTrackerLiveOntology(
    adapter: OntologyAdapter
): LiveOntology<FoundryDbIssueTrackerOntology> {
    return createLiveOntology<FoundryDbIssueTrackerOntology>({
        ir: ontology,
        adapter,
    });
}
