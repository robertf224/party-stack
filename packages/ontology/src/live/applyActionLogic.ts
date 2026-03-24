import { set } from "lodash-es";
import { evaluateExpression, getObjectReferenceObjectType } from "./expression.js";
import type { OntologyCollection, OntologyObject } from "./LiveOntology.js";
import type { ObjectTypeDef, OntologyIR, PropertyAssignment } from "../ir/index.js";

function applyPropertyAssignments(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    object: Record<string, unknown>;
    assignments: PropertyAssignment[];
    parameters: Record<string, unknown>;
    context: Record<string, unknown>;
    objects: Record<string, OntologyCollection<OntologyObject>>;
    objectType: ObjectTypeDef;
}): void {
    const resolveParameter = (parameterName: string) => opts.parameters[parameterName];

    for (const assignment of opts.assignments) {
        const value = evaluateExpression(
            opts.ir,
            opts.actionTypeName,
            assignment.value,
            resolveParameter,
            opts.context,
            opts.objects
        );
        set(opts.object, assignment.property, value);
    }
}

export function applyActionLogic(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    context: Record<string, unknown>;
    objects: Record<string, OntologyCollection<OntologyObject>>;
}): void {
    const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === opts.actionTypeName)!;

    for (const step of actionType.logic) {
        switch (step.kind) {
            case "createObject": {
                const objectType = opts.ir.objectTypes.find(
                    (objectType) => objectType.name === step.value.objectType
                )!;
                const collection = opts.objects[objectType.name]!;
                const createdObject: Record<string, unknown> = {};
                applyPropertyAssignments({
                    ir: opts.ir,
                    actionTypeName: opts.actionTypeName,
                    object: createdObject,
                    assignments: step.value.values,
                    parameters: opts.parameters,
                    context: opts.context,
                    objects: opts.objects,
                    objectType,
                });
                collection.insert(createdObject);
                break;
            }
            case "updateObject": {
                const objectType = getObjectReferenceObjectType(
                    opts.ir,
                    opts.actionTypeName,
                    step.value.object
                );
                const collection = opts.objects[objectType.name]!;
                const primaryKey = opts.parameters[step.value.object.path[0]!] as string | number;
                collection.update(primaryKey, (draft) => {
                    applyPropertyAssignments({
                        ir: opts.ir,
                        actionTypeName: opts.actionTypeName,
                        object: draft as Record<string, unknown>,
                        assignments: step.value.values,
                        parameters: opts.parameters,
                        context: opts.context,
                        objects: opts.objects,
                        objectType,
                    });
                });
                break;
            }
            case "deleteObject": {
                const objectType = getObjectReferenceObjectType(
                    opts.ir,
                    opts.actionTypeName,
                    step.value.object
                );
                const collection = opts.objects[objectType.name]!;
                const primaryKey = opts.parameters[step.value.object.path[0]!] as string | number;
                collection.delete(primaryKey);
                break;
            }
        }
    }
}
