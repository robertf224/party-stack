import {
    and,
    eq,
    gt,
    gte,
    inArray,
    IR,
    lt,
    lte,
    not,
    or,
} from "@tanstack/db";
import { get } from "lodash-es";
import { Temporal } from "temporal-polyfill";
import { resolveType, unwrapType } from "../utils/types.js";
import type { OntologyReadTx } from "./mutators/types.js";
import type { OntologyObject } from "./objects/OntologyObject.js";
import type {
    Expression,
    ObjectTypeDef,
    ObjectQueryPredicate,
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

function getQueryProperty(reference: unknown, path: string[]): unknown {
    return path.reduce(
        (value, segment) =>
            (value as Record<string, unknown>)[segment],
        reference
    );
}

function combineQueryExpressions(
    kind: "and" | "or",
    expressions: IR.BasicExpression<boolean>[]
): IR.BasicExpression<boolean> {
    const [first, second, ...rest] = expressions;
    if (!first) {
        throw new Error(`Object-query ${kind} predicate is empty.`);
    }
    if (!second) return first;
    return kind === "and"
        ? and(first, second, ...rest)
        : or(first, second, ...rest);
}

function compileObjectQueryPredicate(
    predicate: ObjectQueryPredicate,
    object: unknown
): IR.BasicExpression<boolean> {
    switch (predicate.kind) {
        case "eq":
            return eq(
                getQueryProperty(object, predicate.value.property) as never,
                predicate.value.value as never
            );
        case "in":
            return inArray(
                getQueryProperty(object, predicate.value.property) as never,
                predicate.value.values as never
            );
        case "range": {
            const property = getQueryProperty(
                object,
                predicate.value.property
            ) as never;
            const bounds: IR.BasicExpression<boolean>[] = [
                predicate.value.lt !== undefined
                    ? lt(property, predicate.value.lt as never)
                    : undefined,
                predicate.value.lte !== undefined
                    ? lte(property, predicate.value.lte as never)
                    : undefined,
                predicate.value.gt !== undefined
                    ? gt(property, predicate.value.gt as never)
                    : undefined,
                predicate.value.gte !== undefined
                    ? gte(property, predicate.value.gte as never)
                    : undefined,
            ].filter((bound): bound is NonNullable<typeof bound> => bound !== undefined);
            return combineQueryExpressions("and", bounds);
        }
        case "and": {
            const predicates = predicate.value.predicates.map((child) =>
                compileObjectQueryPredicate(child, object)
            );
            return combineQueryExpressions("and", predicates);
        }
        case "or": {
            const predicates = predicate.value.predicates.map((child) =>
                compileObjectQueryPredicate(child, object)
            );
            return combineQueryExpressions("or", predicates);
        }
        case "not":
            return not(
                compileObjectQueryPredicate(
                    predicate.value.predicate,
                    object
                ) as never
            );
    }
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
        case "objectQuery": {
            const objectType = ir.objectTypes.find(
                (candidate) =>
                    candidate.name === expression.value.objectType
            );
            if (!objectType) {
                throw new Error(
                    `Unknown object type "${expression.value.objectType}" in object-query expression.`
                );
            }
            const rows = await tx.query<Array<{ primaryKey: unknown }>>(
                (query, objects) => {
                    let objectQuery = query.from({
                        object: objects[objectType.name]!,
                    });
                    if (expression.value.where) {
                        objectQuery = objectQuery.where(
                            ({ object }) =>
                                compileObjectQueryPredicate(
                                    expression.value.where!,
                                    object
                                ) as never
                        );
                    }
                    return objectQuery
                        .orderBy(
                            ({ object }) =>
                                object[
                                    objectType.primaryKey
                                ],
                            "asc"
                        )
                        .limit(2)
                        .select(({ object }) => ({
                            primaryKey:
                                object[
                                    objectType.primaryKey
                                ],
                        }));
                }
            );
            return rows.length === 1
                ? rows[0]?.primaryKey
                : undefined;
        }
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
