// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology } from "./types";
import type { LiveOntologyOpts, OntologyAdapter } from "@party-stack/ontology";

export function createIssueTrackerLiveOntology(
    adapter: OntologyAdapter,
    opts?: Pick<LiveOntologyOpts, "blobStore" | "getContext" | "id">
): LiveOntology<IssueTrackerOntology> {
    return createLiveOntology<IssueTrackerOntology>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        getContext: opts?.getContext,
    });
}
