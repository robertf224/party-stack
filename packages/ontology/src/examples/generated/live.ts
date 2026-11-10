// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../blog.js";
import type { LiveOntologyFactoryOptions } from "../../index.js";
import type { BlogOntology } from "./types.js";

export async function createBlogLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: LiveOntologyFactoryOptions<Context>): Promise<LiveOntology<BlogOntology>> {
    return createLiveOntology<BlogOntology, Context>({
        ...opts,
        ir: ontology,
    });
}
