// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../blog.js";
import type { BlogOntology } from "./types.js";
import type { CreateLiveOntologyOpts, OntologyAdapter } from "../../index.js";

export function createBlogLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(
    adapter: OntologyAdapter,
    opts?: Pick<CreateLiveOntologyOpts<Context>, "blobStore" | "context" | "getUserId" | "id">
): LiveOntology<BlogOntology> {
    return createLiveOntology<BlogOntology, Context>({
        ir: ontology,
        adapter,
        id: opts?.id,
        blobStore: opts?.blobStore,
        context: opts?.context,
        getUserId: opts?.getUserId,
    });
}
