// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../blog.js";
import type { BlogOntology } from "./types.js";
import type { LiveOntologyOpts, OntologyAdapter } from "../../index.js";

export function createBlogLiveOntology(
    adapter: OntologyAdapter,
    opts?: Pick<LiveOntologyOpts, "blobStore" | "getContext" | "id">
): LiveOntology<BlogOntology> {
    return createLiveOntology<BlogOntology>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        getContext: opts?.getContext,
    });
}
