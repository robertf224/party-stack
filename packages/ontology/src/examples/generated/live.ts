// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "../../index.js";
import ontology from "../blog.js";
import type { BlogOntology } from "./types.js";
import type { CreateLiveOntologyOpts } from "../../index.js";

export async function createBlogLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: Omit<CreateLiveOntologyOpts<Context>, "ir">): Promise<LiveOntology<BlogOntology>> {
    return createLiveOntology<BlogOntology, Context>({
        ...opts,
        ir: ontology,
    });
}
