"use client";
import { createContext, useContext } from "react";
import type { LiveOntology, OntologyDefinition } from "@party-stack/ontology";
export const OntologyContext = createContext<LiveOntology | undefined>(undefined);
/** Optional access for commands such as actions, attachments and offline pins.
 * Generated collection descriptors can be queried directly without this hook.
 */
export function useOntology<
    Definition extends OntologyDefinition = OntologyDefinition,
>(): LiveOntology<Definition> {
    const ontology = useContext(OntologyContext);
    if (!ontology) throw new Error("useOntology requires an OntologyProvider.");
    return ontology as unknown as LiveOntology<Definition>;
}
