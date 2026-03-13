import { ObjectRid, ObjectTypeApiName, OntologyObjectV2 } from "@osdk/foundry.ontologies";

export type PrimaryKeyValue = string | number;

export interface TypedOntologyObject extends OntologyObjectV2 {
    __apiName: ObjectTypeApiName;
    __rid?: ObjectRid;
    __primaryKey: PrimaryKeyValue;
    __title: string;
}
