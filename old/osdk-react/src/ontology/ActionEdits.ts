import { ObjectTypeDefinition, Osdk } from "@osdk/api";
import { ObjectReference } from "./OntologyObservation";

export interface ActionEdits {
    createdObjects: Osdk.Instance<ObjectTypeDefinition>[];
    modifiedObjects: Osdk.Instance<ObjectTypeDefinition>[];
    deletedObjects: ObjectReference[];
}
