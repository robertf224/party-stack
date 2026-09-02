import { eq } from "@tanstack/db";
import { get } from "lodash-es";
import { Temporal } from "temporal-polyfill";
import { resolveType, unwrapType } from "../utils/types.js";
import type { OntologyReadTx } from "./mutators/types.js";
import type { OntologyObject } from "./objects/OntologyObject.js";
import type {
    Expression,
    ObjectTypeDef,
    OntologyIR,
    TypeDef,
    ValueReferenceExpression,
} from "../ir/index.js";

function getActionType(
    ir: OntologyIR,
    actionTypeName: string
) {
    return ir.actionTypes.find(
        (actionType) => actionType.name === actionTypeName
    )!;
}

export async function evaluateExpression(options: {
    ir: OntologyIR;
    actionTypeName: string;
    expression: Expression;
    resolveParameter: (
        parameterName: string
    ) => Promise<unknown>;
    context: Record<string, unknown>;
    tx: OntologyReadTx;
}): Promise<unknown> {
    const {
        ir,
        actionTypeName,
        expression,
        resolveParameter,
        context,
        tx,
    } = options;

    switch (expression.kind) {
        case "valueReference": {
            const [parameterName, ...path] =
                expression.value.path;
            const parameterValue =
                await resolveParameter(parameterName!);
            if (path.length === 0) return parameterValue;

            const actionType = getActionType(
                ir,
                actionTypeName
            );
            const parameter = actionType.parameters.find(
                (candidate) =>
                    candidate.name === parameterName
            )!;
            const {
                type: parameterType,
                isOptional: parameterIsOptional,
            } = unwrapType(resolveType(ir, parameter.type));

            if (parameterType.kind !== "objectReference") {
                return get(parameterValue, path);
            }

            const referencedType = ir.objectTypes.find(
                (candidate) =>
                    candidate.name ===
                    parameterType.value.objectType
            )!;
            // Object-reference values are represented by their primary key.
            // Avoid an on-demand subset load just to read that same key.
            if (
                path.length === 1 &&
                path[0] === referencedType.primaryKey
            ) {
                return parameterValue;
            }
            const referencedObject = await tx.query<
                OntologyObject | undefined
            >((query, objects) =>
                query
                    .from({
                        object: objects[referencedType.name]!,
                    })
                    .where(({ object }) =>
                        eq(
                            object[referencedType.primaryKey],
                            parameterValue
                        )
                    )
                    .select(({ object }) => object)
                    .findOne()
            );
            if (!referencedObject && !parameterIsOptional) {
                throw new Error(
                    `Missing loaded "${referencedType.name}" object for parameter "${parameterName}" (${String(parameterValue)}).`
                );
            }
            return get(referencedObject, path);
        }
        case "contextReference":
            return get(context, expression.value.path);
        case "literal":
            return expression.value.value;
        case "functionCall":
            return expression.value.kind === "uuid"
                ? globalThis.crypto.randomUUID()
                : Temporal.Now.instant();
    }
}

export async function resolveActionParameters(options: {
    ir: OntologyIR;
    actionTypeName: string;
    initialParameters: Record<string, unknown>;
    context: Record<string, unknown>;
    tx: OntologyReadTx;
}): Promise<Record<string, unknown>> {
    const action = getActionType(
        options.ir,
        options.actionTypeName
    );
    const resolvedParameters = {
        ...options.initialParameters,
    };
    const parametersByName = new Map(
        action.parameters.map((parameter) => [
            parameter.name,
            parameter,
        ])
    );
    const resolving = new Set<string>();

    const resolveParameter = async (
        parameterName: string
    ): Promise<unknown> => {
        if (resolvedParameters[parameterName] !== undefined) {
            return resolvedParameters[parameterName];
        }
        const parameter = parametersByName.get(parameterName);
        if (!parameter?.defaultValue) return undefined;
        if (resolving.has(parameterName)) {
            throw new Error(
                `Circular action parameter default for "${parameterName}".`
            );
        }

        resolving.add(parameterName);
        try {
            resolvedParameters[parameterName] =
                await evaluateExpression({
                    ir: options.ir,
                    actionTypeName: options.actionTypeName,
                    expression: parameter.defaultValue,
                    resolveParameter,
                    context: options.context,
                    tx: options.tx,
                });
            return resolvedParameters[parameterName];
        } finally {
            resolving.delete(parameterName);
        }
    };

    for (const parameter of action.parameters) {
        await resolveParameter(parameter.name);
    }
    return resolvedParameters;
}

export function getObjectReferenceObjectType(
    ir: OntologyIR,
    actionTypeName: string,
    reference: ValueReferenceExpression
): ObjectTypeDef {
    const actionType = getActionType(ir, actionTypeName);
    const parameter = actionType.parameters.find(
        (candidate) =>
            candidate.name === reference.path[0]
    )!;
    const resolvedType = unwrapType(
        resolveType(ir, parameter.type)
    ).type as Extract<TypeDef, { kind: "objectReference" }>;
    return ir.objectTypes.find(
        (candidate) =>
            candidate.name === resolvedType.value.objectType
    )!;
}
