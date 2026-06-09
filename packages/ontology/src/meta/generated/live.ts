// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../ontology.js";
import type { MetaOntology } from "./types.js";
import type { LiveOntologyOpts, OntologyAdapter } from "../../index.js";

export function createMetaLiveOntology(
    adapter: OntologyAdapter,
    opts?: Pick<LiveOntologyOpts, "blobStore" | "getContext" | "id">
): LiveOntology<MetaOntology> {
    return createLiveOntology<MetaOntology>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        getContext: opts?.getContext,
    });
}
