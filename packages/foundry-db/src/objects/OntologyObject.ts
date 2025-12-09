import { OntologyObjectV2 } from "@osdk/foundry.ontologies";

export interface OntologyObject extends OntologyObjectV2 {
    __primaryKey: string | number;
}
