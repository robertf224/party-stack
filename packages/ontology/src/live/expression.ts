import { get } from "lodash-es";
import { Temporal } from "temporal-polyfill";
import type { OntologyCollection, OntologyObject } from "./LiveOntology.js";
import type {
    Expression,
    ObjectTypeDef,
    OntologyIR,
    TypeDef,
    ValueReferenceExpression,
} from "../ir/index.js";

function getActionType(ir: OntologyIR, actionTypeName: string) {
    return ir.actionTypes.find((actionType) => actionType.name === actionTypeName)!;
}

function unwrapType(type: TypeDef): { type: TypeDef; isOptional: boolean } {
    if (type.kind === "optional") {
        return { type: type.value.type, isOptional: true };
    }
    return { type, isOptional: false };
}

function resolveType(type: TypeDef, ir: OntologyIR): TypeDef {
    if (type.kind === "ref") {
        return resolveType(ir.types.find((t) => t.name === type.value.name)!.type, ir);
    }
    return type;
}

export function evaluateExpression(
    ir: OntologyIR,
    actionTypeName: string,
    expression: Expression,
    resolveParameter: (parameterName: string) => unknown,
    context: Record<string, unknown>,
    objects: Record<string, OntologyCollection<OntologyObject>>
): unknown {
    switch (expression.kind) {
        case "valueReference": {
            const [parameterName, ...path] = expression.value.path;

            const parameterValue = resolveParameter(parameterName!);
            if (path.length === 0) {
                return parameterValue;
            }

            const actionType = getActionType(ir, actionTypeName);
            const { type: parameterType, isOptional: parameterIsOptional } = unwrapType(
                resolveType(
                    actionType.parameters.find((parameter) => parameter.name === parameterName)!.type,
                    ir
                )
            );

            if (parameterType.kind === "objectReference") {
                const objectType = ir.objectTypes.find(
                    (objectType) => objectType.name === parameterType.value.objectType
                )!;
                const collection = objects[objectType.name];
                const referencedObject = collection?.get(parameterValue as string | number);
                if (!referencedObject && !parameterIsOptional) {
                    throw new Error(
                        `Missing loaded "${objectType.name}" object for parameter "${parameterName}" (${String(parameterValue)}).`
                    );
                }
                return get(referencedObject, path);
            } else {
                return get(parameterValue, path);
            }
        }
        case "contextReference":
            return get(context, expression.value.path);
        case "functionCall":
            switch (expression.value.kind) {
                case "uuid":
                    return globalThis.crypto.randomUUID();
                case "now":
                    return Temporal.Now.instant();
            }
    }
}

export function resolveActionParameters(
    ir: OntologyIR,
    actionTypeName: string,
    initialParameters: Record<string, unknown>,
    context: Record<string, unknown>,
    objects: Record<string, OntologyCollection<OntologyObject>>
): Record<string, unknown> {
    const action = getActionType(ir, actionTypeName);
    const resolvedParameters = { ...initialParameters };
    const parametersByName = new Map(action.parameters.map((parameter) => [parameter.name, parameter]));
    const resolving = new Set<string>();

    const resolveParameter = (parameterName: string): unknown => {
        if (resolvedParameters[parameterName] !== undefined) {
            return resolvedParameters[parameterName];
        }

        const parameter = parametersByName.get(parameterName);
        if (!parameter || !parameter.defaultValue) {
            return undefined;
        }
        if (resolving.has(parameterName)) {
            throw new Error(`Circular action parameter default for "${parameterName}".`);
        }

        resolving.add(parameterName);
        resolvedParameters[parameterName] = evaluateExpression(
            ir,
            actionTypeName,
            parameter.defaultValue,
            resolveParameter,
            context,
            objects
        );
        resolving.delete(parameterName);
        return resolvedParameters[parameterName];
    };

    for (const parameter of action.parameters) {
        resolveParameter(parameter.name);
    }

    return resolvedParameters;
}

export function getObjectReferenceObjectType(
    ir: OntologyIR,
    actionTypeName: string,
    reference: ValueReferenceExpression
): ObjectTypeDef {
    const actionType = getActionType(ir, actionTypeName);
    const parameter = actionType.parameters.find((parameter) => parameter.name === reference.path[0])!;
    const resolvedType = unwrapType(resolveType(parameter.type, ir)).type as Extract<
        TypeDef,
        { kind: "objectReference" }
    >;
    return ir.objectTypes.find((objectType) => objectType.name === resolvedType.value.objectType)!;
}
