import type { OntologyObject } from "@party-stack/ontology-spec";
import type { Collection } from "@tanstack/db";
export type OntologyCollection<T extends OntologyObject> = Collection<T, string | number>;
