// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../blog.js";
import type { BlogOntology } from "./types.js";
import type { LiveOntologyOpts, OntologyAdapter } from "../../index.js";

export function createBlogLiveOntology(
    adapter: OntologyAdapter,
    opts?: Pick<LiveOntologyOpts, "getContext">
): LiveOntology<BlogOntology> {
    return createLiveOntology<BlogOntology>({
        ir: ontology,
        adapter,
        getContext: opts?.getContext,
    });
}
