import type { LiveOntology, OntologyDefinition } from "@party-stack/ontology";
import type { TanStackDevtoolsReactPlugin } from "@tanstack/react-devtools";

export interface OntologyDevtoolsPanelProps<
    Ontology extends OntologyDefinition = OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
> {
    ontology: LiveOntology<Ontology>;
    metaOntology?: LiveOntology<MetaOntology>;
    theme?: "light" | "dark";
}

export interface OntologyDevtoolsPluginOptions<
    Ontology extends OntologyDefinition = OntologyDefinition,
    MetaOntology extends OntologyDefinition = OntologyDefinition,
> {
    ontology: LiveOntology<Ontology>;
    id?: string;
    metaOntology?: LiveOntology<MetaOntology>;
    name?: TanStackDevtoolsReactPlugin["name"];
    defaultOpen?: boolean;
}
