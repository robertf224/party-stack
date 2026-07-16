// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { IssueTrackerOntology } from "./types";
import type { CreateLiveOntologyOpts, OntologyAdapter } from "@party-stack/ontology";

export function createIssueTrackerLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(
    adapter: OntologyAdapter,
    opts?: Pick<CreateLiveOntologyOpts<Context>, "blobStore" | "context" | "getUserId" | "id">
): LiveOntology<IssueTrackerOntology> {
    return createLiveOntology<IssueTrackerOntology, Context>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        context: opts?.context,
        getUserId: opts?.getUserId,
    });
}
