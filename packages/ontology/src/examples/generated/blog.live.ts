// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../LiveOntology.js";
import { blogOntology } from "../blog.js";
import type { OntologyByObjectType, BlogLinkMap } from "./blog.types.js";
import type { OntologyAdapter } from "../../OntologyAdapter.js";

export const objectTypeNames = ["Author", "Post", "Comment"] as const;

export type BlogLiveOntology = LiveOntology<OntologyByObjectType, BlogLinkMap>;

export function createBlogLiveOntology(adapter: OntologyAdapter): BlogLiveOntology {
    return createLiveOntology<OntologyByObjectType, BlogLinkMap>({
        ir: blogOntology,
        adapter,
    });
}
