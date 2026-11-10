// Auto-generated file - do not edit manually

import {
    createLiveOntology,
    type LiveOntologyFactoryOptions,
    type LiveOntology,
} from "@party-stack/ontology";
import ontology from "../ontology";
import type { NotesOntology, NotesOntologyContext } from "./types";

export async function createNotesLiveOntology(
    opts: LiveOntologyFactoryOptions<NotesOntologyContext>
): Promise<LiveOntology<NotesOntology>> {
    return createLiveOntology<NotesOntology, NotesOntologyContext>({
        ...opts,
        ir: ontology,
    });
}
