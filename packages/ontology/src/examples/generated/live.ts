// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../LiveOntology.js";
import ontology from "../blog.js";
import type { BlogOntology } from "./types.js";
import type { OntologyAdapter } from "../../OntologyAdapter.js";

export function createBlogLiveOntology(adapter: OntologyAdapter): LiveOntology<BlogOntology> {
    return createLiveOntology<BlogOntology>({
        ir: ontology,
        adapter,
    });
}
