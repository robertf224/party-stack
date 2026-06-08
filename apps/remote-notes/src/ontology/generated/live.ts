// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { RemoteNotesOntology } from "./types";
import type { LiveOntologyOpts, OntologyAdapter } from "@party-stack/ontology";

export function createRemoteNotesLiveOntology(
    adapter: OntologyAdapter,
    opts?: Pick<LiveOntologyOpts, "blobStore" | "getContext" | "id">
): LiveOntology<RemoteNotesOntology> {
    return createLiveOntology<RemoteNotesOntology>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        getContext: opts?.getContext,
    });
}
