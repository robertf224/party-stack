import type { ObjectTypeDefinition, Osdk } from "@osdk/api";

export interface ObjectReference {
    objectType: string;
    primaryKey: string | number | boolean;
}

// TODO: maybe advertise that we’ve learned an object set is completely known to possibly complete some other ones
export interface OntologyObservation {
    knownObjects: Osdk<ObjectTypeDefinition>[];
    deletedObjects: ObjectReference[];
}
