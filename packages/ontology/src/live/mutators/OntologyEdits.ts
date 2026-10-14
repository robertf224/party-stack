import { setAtPath } from "../../utils/paths.js";
import { unwrapValueType } from "../../utils/types.js";
import { decorateObjectAttachmentSources } from "../attachments/attachmentSources.js";
import { evaluateExpression, getObjectReferenceObjectType } from "../expression.js";
import type { ObjectTypeDef, OntologyIR, PropertyAssignment } from "../../ir/index.js";
import type {
    OntologyMutatorObjects,
    OntologyMutatorTx,
    OntologyPropertyChange,
    OntologyReadTx,
} from "./types.js";

function objectType(ir: OntologyIR, name: string): ObjectTypeDef {
    const type = ir.objectTypes.find((candidate) => candidate.name === name);
    if (!type) throw new Error(`Unknown object type "${name}".`);
    return type;
}

async function propertyChanges(options: {
    ir: OntologyIR;
    actionTypeName: string;
    assignments: PropertyAssignment[];
    parameters: Record<string, unknown>;
    context: Record<string, unknown>;
    tx: OntologyReadTx;
}): Promise<OntologyPropertyChange[]> {
    const changes: OntologyPropertyChange[] = [];
    for (const assignment of options.assignments) {
        const value = await evaluateExpression({
            ir: options.ir,
            actionTypeName: options.actionTypeName,
            expression: assignment.value,
            resolveParameter: (name) => Promise.resolve(options.parameters[name]),
            context: options.context,
            tx: options.tx,
        });
        if (value !== undefined) {
            changes.push({ path: assignment.property, value });
        }
    }
    return changes;
}

export async function applyActionLogicToMutatorTx(options: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    context: Record<string, unknown>;
    idempotencyKey?: string;
    objects: OntologyMutatorObjects;
    tx: OntologyMutatorTx;
}): Promise<void> {
    const action = options.ir.actionTypes.find((candidate) => candidate.name === options.actionTypeName);
    if (!action) {
        throw new Error(`Unknown action "${options.actionTypeName}".`);
    }

    for (const [stepIndex, step] of action.logic.entries()) {
        if (step.kind === "createObject") {
            const type = objectType(options.ir, step.value.objectType);
            let object: Record<string, unknown> = {};
            for (const change of await propertyChanges({ ...options, assignments: step.value.values })) {
                object = setAtPath(object, change.path, change.value);
            }
            decorateObjectAttachmentSources({ ir: options.ir, objectType: type, object });
            if (object[type.primaryKey] === undefined) {
                const primaryKey = type.properties.find((property) => property.name === type.primaryKey);
                if (
                    !options.idempotencyKey ||
                    !primaryKey ||
                    unwrapValueType(options.ir, primaryKey.type).kind !== "string"
                ) {
                    continue;
                }
                // Temporary view key for backend-assigned IDs. This is stable
                // across outbox projection replay, but it cannot support
                // dependent edits until local-to-remote view-key mapping exists.
                object[type.primaryKey] = `optimistic:${options.idempotencyKey}:${type.name}:${stepIndex}`;
            }
            await options.tx.mutate[type.name]!.create(object);
            continue;
        }

        const type = getObjectReferenceObjectType(options.ir, options.actionTypeName, step.value.object);
        const key = options.parameters[step.value.object.name] as string | number;
        if (step.kind === "updateObject") {
            await options.tx.mutate[type.name]!.update(
                key,
                await propertyChanges({ ...options, assignments: step.value.values })
            );
        } else {
            await options.tx.mutate[type.name]!.delete(key);
        }
    }
}
