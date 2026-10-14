import { eq } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import { isLinkHopFromForeignKeySource, resolveLinkHop } from "../utils/links.js";
import { getAtPath } from "../utils/paths.js";
import { resolveType, unwrapType } from "../utils/types.js";
import type {
    Expression,
    ObjectTypeDef,
    OntologyIR,
    TypeDef,
    InputReferenceExpression,
} from "../ir/index.js";
import type { OntologyReadTx } from "./mutators/types.js";
import type { OntologyObject } from "./objects/OntologyObject.js";

function getActionType(ir: OntologyIR, actionTypeName: string) {
    return ir.actionTypes.find((actionType) => actionType.name === actionTypeName)!;
}

interface EvaluateExpressionOptions {
    ir: OntologyIR;
    actionTypeName: string;
    expression: Expression;
    resolveParameter: (parameterName: string) => Promise<unknown>;
    context: Record<string, unknown>;
    tx: OntologyReadTx;
}

const ontologyReference = Symbol("ontologyReference");
const ontologyObject = Symbol("ontologyObject");

interface EvaluatedObjectReference {
    [ontologyReference]: true;
    objectType: string;
    key: unknown;
    optional: boolean;
}

interface EvaluatedOntologyObject {
    [ontologyObject]: true;
    objectType: string;
    value: OntologyObject;
}

function isEvaluatedObjectReference(value: unknown): value is EvaluatedObjectReference {
    return typeof value === "object" && value !== null && ontologyReference in value;
}

function isEvaluatedOntologyObject(value: unknown): value is EvaluatedOntologyObject {
    return typeof value === "object" && value !== null && ontologyObject in value;
}

function unwrapEvaluatedValue(value: unknown): unknown {
    if (isEvaluatedObjectReference(value)) return value.key;
    if (isEvaluatedOntologyObject(value)) return value.value;
    if (Array.isArray(value)) return value.map(unwrapEvaluatedValue);
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, unwrapEvaluatedValue(entry)])
        );
    }
    return value;
}

export async function evaluateExpression(options: EvaluateExpressionOptions): Promise<unknown> {
    return unwrapEvaluatedValue(await evaluateExpressionWithLocals(options, new Map()));
}

async function evaluateExpressionWithLocals(
    options: EvaluateExpressionOptions,
    locals: ReadonlyMap<string, unknown>
): Promise<unknown> {
    const { ir, actionTypeName, expression, resolveParameter, context, tx } = options;

    switch (expression.kind) {
        case "inputReference": {
            const parameterValue = await resolveParameter(expression.value.name);
            const actionType = getActionType(ir, actionTypeName);
            const parameter = actionType.parameters.find(
                (candidate) => candidate.name === expression.value.name
            )!;
            const { type: parameterType, isOptional } = unwrapType(resolveType(ir, parameter.type));
            if (parameterType.kind === "objectReference") {
                return {
                    [ontologyReference]: true,
                    objectType: parameterType.value.objectType,
                    key: parameterValue,
                    optional: isOptional,
                };
            }
            return parameterValue;
        }
        case "localReference": {
            const { name } = expression.value;
            if (!locals.has(name)) {
                throw new Error(`Unknown expression binding "${name}".`);
            }
            return locals.get(name);
        }
        case "contextReference":
            return context[expression.value.name];
        case "getAt": {
            const source = await evaluateExpressionWithLocals(
                { ...options, expression: expression.value.source },
                locals
            );
            if (isEvaluatedObjectReference(source)) {
                throw new Error(
                    `Cannot access field "${expression.value.path.join(".")}" on an object reference without an object lookup.`
                );
            }
            return getAtPath(
                isEvaluatedOntologyObject(source) ? source.value : source,
                expression.value.path
            );
        }
        case "objectLookup": {
            const reference = await evaluateExpressionWithLocals(
                { ...options, expression: expression.value.reference },
                locals
            );
            if (!isEvaluatedObjectReference(reference)) {
                throw new Error("Object lookup source must resolve to an object reference.");
            }
            if (reference.key === undefined || reference.key === null) {
                return undefined;
            }
            const referencedType = ir.objectTypes.find(
                (candidate) => candidate.name === reference.objectType
            )!;
            const referencedObject = await tx.query<OntologyObject | undefined>((query, objects) =>
                query
                    .from({ object: objects[referencedType.name]! })
                    .where(({ object }) => eq(object[referencedType.primaryKey], reference.key))
                    .select(({ object }) => object)
                    .findOne()
            );
            if (!referencedObject && !reference.optional) {
                throw new Error(`Missing loaded "${referencedType.name}" object.`);
            }
            return referencedObject
                ? { [ontologyObject]: true, objectType: referencedType.name, value: referencedObject }
                : undefined;
        }
        case "linkHop": {
            const source = await evaluateExpressionWithLocals(
                { ...options, expression: expression.value.source },
                locals
            );
            if (!isEvaluatedOntologyObject(source)) {
                throw new Error("Link hop source must resolve to an ontology object.");
            }
            const link = resolveLinkHop(ir, source.objectType, expression.value.link);
            if (!link) {
                throw new Error(
                    `Unknown link "${expression.value.link}" on object type "${source.objectType}".`
                );
            }
            const foreignKeyOnSource = isLinkHopFromForeignKeySource(
                link,
                source.objectType,
                expression.value.link
            );
            const cardinality = foreignKeyOnSource ? "one" : link.cardinality;
            if (cardinality === "many") {
                throw new Error(
                    `Link "${expression.value.link}" on object type "${source.objectType}" is to-many.`
                );
            }
            const sourceType = ir.objectTypes.find((candidate) => candidate.name === source.objectType)!;
            const targetType = ir.objectTypes.find(
                (candidate) =>
                    candidate.name === (foreignKeyOnSource ? link.target.objectType : link.source.objectType)
            )!;
            const foreignKeyPath = link.foreignKey.split(".");
            const sourceKey = foreignKeyOnSource
                ? getAtPath(source.value, foreignKeyPath)
                : source.value[sourceType.primaryKey];
            if (sourceKey === undefined || sourceKey === null) {
                return undefined;
            }
            const targetProperty = foreignKeyOnSource ? targetType.primaryKey : link.foreignKey;
            const linkedObject = await tx.query<OntologyObject | undefined>((query, objects) =>
                query
                    .from({ object: objects[targetType.name]! })
                    .where(({ object }) => eq(object[targetProperty], sourceKey))
                    .select(({ object }) => object)
                    .findOne()
            );
            return linkedObject
                ? { [ontologyObject]: true, objectType: targetType.name, value: linkedObject }
                : undefined;
        }
        case "struct": {
            const fields = await Promise.all(
                expression.value.fields.map(
                    async (field) =>
                        [
                            field.name,
                            await evaluateExpressionWithLocals(
                                { ...options, expression: field.value },
                                locals
                            ),
                        ] as const
                )
            );
            return Object.fromEntries(fields);
        }
        case "map": {
            const source = await evaluateExpressionWithLocals(
                { ...options, expression: expression.value.source },
                locals
            );
            if (source === undefined) {
                return undefined;
            }
            if (!Array.isArray(source)) {
                throw new Error("Map expression source must resolve to a list.");
            }
            return Promise.all(
                source.map((item) => {
                    const itemLocals = new Map(locals);
                    itemLocals.set(expression.value.binding, item);
                    return evaluateExpressionWithLocals(
                        { ...options, expression: expression.value.body },
                        itemLocals
                    );
                })
            );
        }
        case "literal":
            return expression.value.value;
        case "uuid":
            return globalThis.crypto.randomUUID();
        case "now":
            return Temporal.Now.instant();
    }
}

export async function resolveActionParameters(options: {
    ir: OntologyIR;
    actionTypeName: string;
    initialParameters: Record<string, unknown>;
    context: Record<string, unknown>;
    tx: OntologyReadTx;
}): Promise<Record<string, unknown>> {
    const action = getActionType(options.ir, options.actionTypeName);
    const resolvedParameters = { ...options.initialParameters };
    const parametersByName = new Map(action.parameters.map((parameter) => [parameter.name, parameter]));
    const resolving = new Set<string>();

    const resolveParameter = async (parameterName: string): Promise<unknown> => {
        if (resolvedParameters[parameterName] !== undefined) {
            return resolvedParameters[parameterName];
        }
        const parameter = parametersByName.get(parameterName);
        if (!parameter?.defaultValue) return undefined;
        if (resolving.has(parameterName)) {
            throw new Error(`Circular action parameter default for "${parameterName}".`);
        }

        resolving.add(parameterName);
        try {
            resolvedParameters[parameterName] = await evaluateExpression({
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
    reference: InputReferenceExpression
): ObjectTypeDef {
    const actionType = getActionType(ir, actionTypeName);
    const parameter = actionType.parameters.find((candidate) => candidate.name === reference.name)!;
    const resolvedType = unwrapType(resolveType(ir, parameter.type)).type as Extract<
        TypeDef,
        { kind: "objectReference" }
    >;
    return ir.objectTypes.find((candidate) => candidate.name === resolvedType.value.objectType)!;
}
