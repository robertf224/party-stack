// Auto-generated file - do not edit manually

import { createLiveOntology, type LiveOntology } from "@party-stack/ontology";
import ontology from "../ontology";
import type { RemoteNotesOntology } from "./types";
import type { CreateLiveOntologyOpts } from "@party-stack/ontology";

export async function createRemoteNotesLiveOntology<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: Omit<CreateLiveOntologyOpts<Context>, "ir">): Promise<LiveOntology<RemoteNotesOntology>> {
    return createLiveOntology<RemoteNotesOntology, Context>({
        ...opts,
        ir: ontology,
    });
}
