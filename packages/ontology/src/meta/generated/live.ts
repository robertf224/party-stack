// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../ontology.js";
import type { MetaOntology } from "./types.js";
import type { CreateLiveOntologyOpts, OntologyAdapter } from "../../index.js";

export function createMetaLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(
    adapter: OntologyAdapter,
    opts?: Pick<CreateLiveOntologyOpts<Context>, "blobStore" | "context" | "getUserId" | "id">
): LiveOntology<MetaOntology> {
    return createLiveOntology<MetaOntology, Context>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        context: opts?.context,
        getUserId: opts?.getUserId,
    });
}
