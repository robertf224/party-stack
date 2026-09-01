import { Temporal } from "temporal-polyfill";
import type {
    ActionLogicStep,
    ActionParameterDef,
    ActionParameterPrefill,
    ActionTypeDef,
    Expression,
    ObjectTypeDef,
    OntologyDefinition,
    OntologyIR,
    PropertyAssignment,
    TypeDef,
    ValueReferenceExpression,
} from "@party-stack/ontology";

export type FixedActionParameterValue = Expression;

export type FixedActionParameterValues<
    Ontology extends OntologyDefinition = OntologyDefinition,
> = {
    [ActionTypeName in Extract<
        keyof Ontology["actionTypes"],
        string
    >]?: {
        [ParameterName in Extract<
            keyof Ontology["actionTypes"][ActionTypeName]["parameters"],
            string
        >]?: FixedActionParameterValue;
    };
};

type RuntimeFixedActionParameterValues = Record<
    string,
    Record<string, FixedActionParameterValue> | undefined
>;

export type ClientContextProjectionMode = "none" | "forward" | "projected";

function getPath(value: unknown, path: string[]): unknown {
    let current = value;
    for (const segment of path) {
        if (typeof current !== "object" || current === null) return undefined;
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

function hasPath(value: unknown, path: string[]): boolean {
    let current = value;
    for (const segment of path) {
        if (typeof current !== "object" || current === null || !(segment in current)) return false;
        current = (current as Record<string, unknown>)[segment];
    }
    return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function literal(value: unknown): Expression {
    return {
        kind: "literal",
        value: { value },
    };
}

function resolveType(ir: OntologyIR, type: TypeDef): TypeDef {
    if (type.kind !== "ref") return type;
    const namedType = ir.types.find((candidate) => candidate.name === type.value.name);
    if (!namedType) {
        throw new Error(`Unknown ontology type "${type.value.name}".`);
    }
    return resolveType(ir, namedType.type);
}

function getActionType(ir: OntologyIR, actionTypeName: string): ActionTypeDef {
    const actionType = ir.actionTypes.find((candidate) => candidate.name === actionTypeName);
    if (!actionType) {
        throw new Error(`Unknown action type "${actionTypeName}".`);
    }
    return actionType;
}

function getObjectType(ir: OntologyIR, objectTypeName: string): ObjectTypeDef {
    const objectType = ir.objectTypes.find((candidate) => candidate.name === objectTypeName);
    if (!objectType) {
        throw new Error(`Unknown object type "${objectTypeName}".`);
    }
    return objectType;
}

function getObjectReferenceObjectType(ir: OntologyIR, actionType: ActionTypeDef, reference: ValueReferenceExpression): string {
    const parameter = actionType.parameters.find((candidate) => candidate.name === reference.path[0]);
    if (!parameter) {
        throw new Error(`Unknown action parameter "${reference.path[0] ?? ""}".`);
    }
    const type = resolveType(ir, parameter.type);
    if (type.kind !== "objectReference") {
        throw new Error(`Action parameter "${parameter.name}" is not an object reference.`);
    }
    return type.value.objectType;
}

function evaluateExpression<Context>(opts: {
    expression: Expression;
    ctx: Context;
    parameters: Record<string, unknown>;
    resolveFixedParameter: (parameterName: string) => unknown;
}): unknown {
    switch (opts.expression.kind) {
        case "contextReference":
            return getPath(opts.ctx, opts.expression.value.path);
        case "literal":
            return opts.expression.value.value;
        case "functionCall":
            switch (opts.expression.value.kind) {
                case "uuid":
                    return globalThis.crypto.randomUUID();
                case "now":
                    return Temporal.Now.instant();
            }
        case "valueReference": {
            const [parameterName, ...path] = opts.expression.value.path;
            if (!parameterName) return undefined;
            const value =
                opts.parameters[parameterName] !== undefined
                    ? opts.parameters[parameterName]
                    : opts.resolveFixedParameter(parameterName);
            return path.length > 0 ? getPath(value, path) : value;
        }
    }
}

function getFixedActionParameterValues(
    fixedActionParameterValues: FixedActionParameterValues | undefined,
    actionName: string
): Record<string, FixedActionParameterValue> | undefined {
    return (fixedActionParameterValues as RuntimeFixedActionParameterValues | undefined)?.[actionName];
}

function isActionParameterFixed<Context>(
    fixedActionParameterValues: FixedActionParameterValues | undefined,
    actionName: string,
    parameterName: string
): boolean {
    return getFixedActionParameterValues(fixedActionParameterValues, actionName)?.[parameterName] !== undefined;
}

function projectExpression<Context>(opts: {
    expression: Expression;
    serverContext: Context;
    clientContext: Record<string, unknown> | undefined;
    clientContextMode: ClientContextProjectionMode;
    actionName: string;
    visibleParameters: Set<string>;
    fixedActionParameterValues: FixedActionParameterValues | undefined;
}): Expression | undefined {
    switch (opts.expression.kind) {
        case "contextReference":
            return opts.clientContextMode === "forward" && hasPath(opts.clientContext, opts.expression.value.path)
                ? opts.expression
                : undefined;
        case "literal":
        case "functionCall":
            return opts.expression;
        case "valueReference": {
            const [parameterName, ...path] = opts.expression.value.path;
            if (!parameterName) return undefined;
            if (opts.visibleParameters.has(parameterName)) return opts.expression;
            const fixedValue = getFixedActionParameterValues(
                opts.fixedActionParameterValues,
                opts.actionName
            )?.[parameterName];
            if (fixedValue === undefined) return undefined;
            if (path.length > 0) {
                if (fixedValue.kind === "contextReference") {
                    const contextPath = [...fixedValue.value.path, ...path];
                    return opts.clientContextMode === "forward" && hasPath(opts.clientContext, contextPath)
                        ? {
                              kind: "contextReference",
                              value: { path: contextPath },
                          }
                        : undefined;
                }
                const value = evaluateExpression({
                    expression: fixedValue,
                    ctx: opts.serverContext,
                    parameters: {},
                    resolveFixedParameter: () => undefined,
                });
                const nestedValue = getPath(value, path);
                return nestedValue === undefined ? undefined : literal(nestedValue);
            }
            if (fixedValue.kind === "contextReference") {
                return opts.clientContextMode === "forward" && hasPath(opts.clientContext, fixedValue.value.path)
                    ? fixedValue
                    : undefined;
            }
            return fixedValue;
        }
    }
}

function projectFoundryObjectSetFilter(
    filter: unknown,
    allowedProperties: readonly string[]
): Record<string, unknown> | undefined {
    const value = asRecord(filter);
    if (!value) return undefined;

    switch (value.type) {
        case "exactMatch": {
            const definition = asRecord(value[value.type]);
            if (
                typeof definition?.propertyId !== "string" ||
                !allowedProperties.includes(definition.propertyId) ||
                !Array.isArray(definition.terms)
            ) {
                return undefined;
            }
            return {
                type: "exactMatch",
                exactMatch: {
                    propertyId: definition.propertyId,
                    terms: definition.terms,
                },
            };
        }
        case "terms": {
            const definition = asRecord(value.terms);
            if (
                typeof definition?.propertyId !== "string" ||
                !allowedProperties.includes(definition.propertyId) ||
                !Array.isArray(definition.terms)
            ) {
                return undefined;
            }
            return {
                type: "terms",
                terms: {
                    propertyId: definition.propertyId,
                    terms: definition.terms,
                },
            };
        }
        case "range": {
            const definition = asRecord(value.range);
            if (
                typeof definition?.propertyId !== "string" ||
                !allowedProperties.includes(definition.propertyId)
            ) {
                return undefined;
            }
            return {
                type: "range",
                range: {
                    propertyId: definition.propertyId,
                    ...Object.fromEntries(
                        ["lt", "lte", "gt", "gte"]
                            .filter((operator) => definition[operator] !== undefined)
                            .map((operator) => [operator, definition[operator]])
                    ),
                },
            };
        }
        case "and":
        case "or": {
            const filters = asRecord(value[value.type])?.filters;
            if (!Array.isArray(filters)) return undefined;
            const projected = filters.map((child) =>
                projectFoundryObjectSetFilter(child, allowedProperties)
            );
            if (projected.some((child) => child === undefined)) return undefined;
            return {
                type: value.type,
                [value.type]: { filters: projected },
            };
        }
        case "not": {
            const projected = projectFoundryObjectSetFilter(
                asRecord(value.not)?.filter,
                allowedProperties
            );
            return projected
                ? {
                      type: "not",
                      not: { filter: projected },
                  }
                : undefined;
        }
        default:
            return undefined;
    }
}

function projectFoundryObjectSet(
    objectSet: unknown,
    allowedProperties: readonly string[]
): Record<string, unknown> | undefined {
    const transforms = asRecord(asRecord(objectSet)?.objectSet)?.transforms;
    if (!Array.isArray(transforms)) return undefined;

    const projectedTransforms: Record<string, unknown>[] = [];
    for (const transform of transforms) {
        const value = asRecord(transform);
        if (value?.type !== "propertyFilter") return undefined;
        const propertyFilter = projectFoundryObjectSetFilter(
            value.propertyFilter,
            allowedProperties
        );
        if (!propertyFilter) return undefined;
        projectedTransforms.push({
            type: "propertyFilter",
            propertyFilter,
        });
    }
    return {
        objectSet: { transforms: projectedTransforms },
        conditionValues: {},
    };
}

function projectActionParameterPrefills(opts: {
    parameter: ActionParameterDef;
    actionType: ActionTypeDef;
    ir: OntologyIR;
    visibleParameters: Set<string>;
    allowedObjectTypeProperties: Record<string, readonly string[]>;
    filterSchemaByAuthorization: boolean;
}): ActionParameterPrefill[] | undefined {
    const prefills = opts.parameter.prefills?.flatMap(
        (prefill): ActionParameterPrefill[] => {
            switch (prefill.kind) {
                case "literal":
                    return [prefill];
                case "objectProperty": {
                    if (!opts.visibleParameters.has(prefill.value.parameter)) {
                        return [];
                    }
                    const sourceParameter = opts.actionType.parameters.find(
                        (parameter) => parameter.name === prefill.value.parameter
                    );
                    if (!sourceParameter) return [];
                    let sourceType = resolveType(opts.ir, sourceParameter.type);
                    while (sourceType.kind === "optional") {
                        sourceType = resolveType(opts.ir, sourceType.value.type);
                    }
                    if (sourceType.kind !== "objectReference") {
                        return [];
                    }
                    const property = prefill.value.property[0];
                    return (
                        property !== undefined &&
                        (
                            opts.allowedObjectTypeProperties[
                                sourceType.value.objectType
                            ] ?? []
                        ).includes(property)
                    )
                        ? [prefill]
                        : [];
                }
                case "foundryObjectQuery": {
                    const allowedProperties =
                        opts.allowedObjectTypeProperties[prefill.value.objectType] ?? [];
                    if (allowedProperties.length === 0) return [];
                    if (!opts.filterSchemaByAuthorization) return [prefill];
                    const objectSet = projectFoundryObjectSet(
                        prefill.value.objectSet,
                        allowedProperties
                    );
                    return objectSet
                        ? [
                              {
                                  ...prefill,
                                  value: {
                                      ...prefill.value,
                                      objectSet,
                                  },
                              },
                          ]
                        : [];
                }
            }
        }
    );
    return prefills && prefills.length > 0 ? prefills : undefined;
}

function projectAssignments<Context>(opts: {
    assignments: PropertyAssignment[];
    serverContext: Context;
    clientContext: Record<string, unknown> | undefined;
    clientContextMode: ClientContextProjectionMode;
    ir: OntologyIR;
    actionName: string;
    objectTypeName: string;
    visibleParameters: Set<string>;
    fixedActionParameterValues: FixedActionParameterValues | undefined;
    allowedObjectTypeProperties: Record<string, readonly string[]>;
}): PropertyAssignment[] {
    const allowedProperties = opts.allowedObjectTypeProperties[opts.objectTypeName] ?? [];
    return opts.assignments.flatMap((assignment) => {
        const propertyName = assignment.property[0];
        if (!propertyName || !allowedProperties.includes(propertyName)) return [];
        const projectedValue = projectExpression({
            expression: assignment.value,
            serverContext: opts.serverContext,
            clientContext: opts.clientContext,
            clientContextMode: opts.clientContextMode,
            actionName: opts.actionName,
            visibleParameters: opts.visibleParameters,
            fixedActionParameterValues: opts.fixedActionParameterValues,
        });
        return projectedValue ? [{ ...assignment, value: projectedValue }] : [];
    });
}

function projectLogicStep<Context>(opts: {
    step: ActionLogicStep;
    serverContext: Context;
    clientContext: Record<string, unknown> | undefined;
    clientContextMode: ClientContextProjectionMode;
    ir: OntologyIR;
    actionType: ActionTypeDef;
    visibleParameters: Set<string>;
    fixedActionParameterValues: FixedActionParameterValues | undefined;
    allowedObjectTypeProperties: Record<string, readonly string[]>;
}): ActionLogicStep | undefined {
    switch (opts.step.kind) {
        case "createObject": {
            const values = projectAssignments({
                assignments: opts.step.value.values,
                serverContext: opts.serverContext,
                clientContext: opts.clientContext,
                clientContextMode: opts.clientContextMode,
                ir: opts.ir,
                actionName: opts.actionType.name,
                objectTypeName: opts.step.value.objectType,
                visibleParameters: opts.visibleParameters,
                fixedActionParameterValues: opts.fixedActionParameterValues,
                allowedObjectTypeProperties: opts.allowedObjectTypeProperties,
            });
            return {
                ...opts.step,
                value: {
                    ...opts.step.value,
                    values,
                },
            };
        }
        case "updateObject": {
            const objectTypeName = getObjectReferenceObjectType(opts.ir, opts.actionType, opts.step.value.object);
            const values = projectAssignments({
                assignments: opts.step.value.values,
                serverContext: opts.serverContext,
                clientContext: opts.clientContext,
                clientContextMode: opts.clientContextMode,
                ir: opts.ir,
                actionName: opts.actionType.name,
                objectTypeName,
                visibleParameters: opts.visibleParameters,
                fixedActionParameterValues: opts.fixedActionParameterValues,
                allowedObjectTypeProperties: opts.allowedObjectTypeProperties,
            });
            return {
                ...opts.step,
                value: {
                    ...opts.step.value,
                    values,
                },
            };
        }
        case "deleteObject":
            return opts.step;
    }
}

function typeReferencesObjectTypes(type: TypeDef, ir: OntologyIR, seen = new Set<string>()): Set<string> {
    if (type.kind === "ref") {
        if (seen.has(type.value.name)) return new Set();
        seen.add(type.value.name);
        const named = ir.types.find((candidate) => candidate.name === type.value.name);
        return named ? typeReferencesObjectTypes(named.type, ir, seen) : new Set();
    }
    switch (type.kind) {
        case "objectReference":
            return new Set([type.value.objectType]);
        case "optional":
            return typeReferencesObjectTypes(type.value.type, ir, seen);
        case "list":
            return typeReferencesObjectTypes(type.value.elementType, ir, seen);
        case "map": {
            const names = typeReferencesObjectTypes(type.value.keyType, ir, seen);
            for (const name of typeReferencesObjectTypes(type.value.valueType, ir, seen)) names.add(name);
            return names;
        }
        case "result": {
            const names = typeReferencesObjectTypes(type.value.okType, ir, seen);
            for (const name of typeReferencesObjectTypes(type.value.errType, ir, seen)) names.add(name);
            return names;
        }
        case "struct": {
            const names = new Set<string>();
            for (const field of type.value.fields) {
                for (const name of typeReferencesObjectTypes(field.type, ir, seen)) names.add(name);
            }
            return names;
        }
        case "union": {
            const names = new Set<string>();
            for (const variant of type.value.variants) {
                for (const name of typeReferencesObjectTypes(variant.type, ir, seen)) names.add(name);
            }
            return names;
        }
        default:
            return new Set();
    }
}

function collectReferencedNamedTypes(type: TypeDef, ir: OntologyIR, into: Set<string>, seen = new Set<string>()): void {
    if (type.kind === "ref") {
        if (seen.has(type.value.name)) return;
        seen.add(type.value.name);
        into.add(type.value.name);
        const named = ir.types.find((candidate) => candidate.name === type.value.name);
        if (named) collectReferencedNamedTypes(named.type, ir, into, seen);
        return;
    }
    switch (type.kind) {
        case "optional":
            collectReferencedNamedTypes(type.value.type, ir, into, seen);
            break;
        case "list":
            collectReferencedNamedTypes(type.value.elementType, ir, into, seen);
            break;
        case "map":
            collectReferencedNamedTypes(type.value.keyType, ir, into, seen);
            collectReferencedNamedTypes(type.value.valueType, ir, into, seen);
            break;
        case "result":
            collectReferencedNamedTypes(type.value.okType, ir, into, seen);
            collectReferencedNamedTypes(type.value.errType, ir, into, seen);
            break;
        case "struct":
            for (const field of type.value.fields) {
                collectReferencedNamedTypes(field.type, ir, into, seen);
            }
            break;
        case "union":
            for (const variant of type.value.variants) {
                collectReferencedNamedTypes(variant.type, ir, into, seen);
            }
            break;
        default:
            break;
    }
}

function actionParametersReferenceHiddenObjectType(
    actionType: ActionTypeDef,
    ir: OntologyIR,
    visibleObjectTypes: Set<string>
): boolean {
    for (const parameter of actionType.parameters) {
        for (const objectType of typeReferencesObjectTypes(parameter.type, ir)) {
            if (!visibleObjectTypes.has(objectType)) return true;
        }
    }
    return false;
}

export function projectRemoteOntologyIR<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(opts: {
    ir: OntologyIR;
    serverContext: Context;
    clientContext?: Record<string, unknown>;
    clientContextMode?: ClientContextProjectionMode;
    fixedActionParameterValues?: FixedActionParameterValues<Ontology>;
    allowedObjectTypeProperties: Record<string, readonly string[]>;
    /**
     * Projects object/property/link/action/query visibility from the resolved
     * authorization policy. Otherwise the full schema is retained while action
     * parameters and logic are still projected.
     */
    filterSchemaByAuthorization?: boolean;
    visibleActionTypes?: readonly string[] | "all";
    visibleQueryFunctionTypes?: readonly string[] | "all";
}): OntologyIR {
    const filterSchemaByAuthorization = opts.filterSchemaByAuthorization ?? false;
    const visibleObjectTypes = new Set(
        filterSchemaByAuthorization
            ? Object.entries(opts.allowedObjectTypeProperties)
                  .filter(([, properties]) => properties.length > 0)
                  .map(([objectType]) => objectType)
            : opts.ir.objectTypes.map((objectType) => objectType.name)
    );

    const objectTypes =
        filterSchemaByAuthorization
            ? opts.ir.objectTypes
                  .filter((objectType) => visibleObjectTypes.has(objectType.name))
                  .map((objectType) => {
                      const allowed = new Set(opts.allowedObjectTypeProperties[objectType.name] ?? []);
                      return {
                          ...objectType,
                          title:
                              objectType.title && allowed.has(objectType.title) ? objectType.title : undefined,
                          properties: objectType.properties.filter((property) => allowed.has(property.name)),
                      };
                  })
            : opts.ir.objectTypes;

    const linkTypes =
        filterSchemaByAuthorization
            ? opts.ir.linkTypes.filter((link) => {
                  if (
                      !visibleObjectTypes.has(link.source.objectType) ||
                      !visibleObjectTypes.has(link.target.objectType)
                  ) {
                      return false;
                  }
                  if (!link.foreignKey) return true;
                  const sourceAllowed = new Set(
                      opts.allowedObjectTypeProperties[link.source.objectType] ?? []
                  );
                  const targetAllowed = new Set(
                      opts.allowedObjectTypeProperties[link.target.objectType] ?? []
                  );
                  return sourceAllowed.has(link.foreignKey) || targetAllowed.has(link.foreignKey);
              })
            : opts.ir.linkTypes;

    const visibleActions =
        opts.visibleActionTypes === undefined || opts.visibleActionTypes === "all"
            ? opts.ir.actionTypes
            : opts.ir.actionTypes.filter((actionType) =>
                  (opts.visibleActionTypes as readonly string[]).includes(actionType.name)
              );

    const actionTypes = visibleActions
        .filter(
            (actionType) =>
                !filterSchemaByAuthorization ||
                !actionParametersReferenceHiddenObjectType(actionType, opts.ir, visibleObjectTypes)
        )
        .map((actionType) => {
            const visibleParameters = new Set(
                actionType.parameters
                    .filter(
                        (parameter) =>
                            !isActionParameterFixed(
                                opts.fixedActionParameterValues,
                                actionType.name,
                                parameter.name
                            )
                    )
                    .map((parameter) => parameter.name)
            );
            return {
                ...actionType,
                parameters: actionType.parameters
                    .filter((parameter) => visibleParameters.has(parameter.name))
                    .map((parameter) => ({
                        ...parameter,
                        prefills: projectActionParameterPrefills({
                            parameter,
                            actionType,
                            ir: opts.ir,
                            visibleParameters,
                            allowedObjectTypeProperties: opts.allowedObjectTypeProperties,
                            filterSchemaByAuthorization,
                        }),
                    })),
                logic: actionType.logic.flatMap((step) => {
                    if (
                        filterSchemaByAuthorization &&
                        step.kind === "createObject" &&
                        !visibleObjectTypes.has(step.value.objectType)
                    ) {
                        return [];
                    }
                    const projectedStep = projectLogicStep({
                        step,
                        serverContext: opts.serverContext,
                        clientContext: opts.clientContext,
                        clientContextMode: opts.clientContextMode ?? "none",
                        ir: opts.ir,
                        actionType,
                        visibleParameters,
                        fixedActionParameterValues: opts.fixedActionParameterValues,
                        allowedObjectTypeProperties: opts.allowedObjectTypeProperties,
                    });
                    return projectedStep ? [projectedStep] : [];
                }),
            };
        });

    const queryFunctionTypes =
        opts.visibleQueryFunctionTypes === undefined || opts.visibleQueryFunctionTypes === "all"
            ? opts.ir.queryFunctionTypes.filter((queryFunction) => {
                  if (!filterSchemaByAuthorization) return true;
                  for (const parameter of queryFunction.parameters) {
                      for (const objectType of typeReferencesObjectTypes(parameter.type, opts.ir)) {
                          if (!visibleObjectTypes.has(objectType)) return false;
                      }
                  }
                  for (const objectType of typeReferencesObjectTypes(queryFunction.returnType, opts.ir)) {
                      if (!visibleObjectTypes.has(objectType)) return false;
                  }
                  return true;
              })
            : opts.ir.queryFunctionTypes.filter((queryFunction) =>
                  (opts.visibleQueryFunctionTypes as readonly string[]).includes(queryFunction.name)
              );

    const referencedNamedTypes = new Set<string>();
    for (const objectType of objectTypes) {
        for (const property of objectType.properties) {
            collectReferencedNamedTypes(property.type, opts.ir, referencedNamedTypes);
        }
    }
    for (const actionType of actionTypes) {
        for (const parameter of actionType.parameters) {
            collectReferencedNamedTypes(parameter.type, opts.ir, referencedNamedTypes);
        }
    }
    for (const queryFunction of queryFunctionTypes) {
        for (const parameter of queryFunction.parameters) {
            collectReferencedNamedTypes(parameter.type, opts.ir, referencedNamedTypes);
        }
        collectReferencedNamedTypes(queryFunction.returnType, opts.ir, referencedNamedTypes);
    }

    return {
        ...opts.ir,
        types: filterSchemaByAuthorization
            ? opts.ir.types.filter((type) => referencedNamedTypes.has(type.name))
            : opts.ir.types,
        objectTypes,
        linkTypes,
        actionTypes,
        queryFunctionTypes,
    };
}

export function applyFixedActionParameterValues<
    Context,
    Ontology extends OntologyDefinition = OntologyDefinition,
>(opts: {
    ctx: Context;
    actionType: string;
    parameters: Record<string, unknown>;
    fixedActionParameterValues?: FixedActionParameterValues<Ontology>;
}): Record<string, unknown> {
    const fixedValues = getFixedActionParameterValues(
        opts.fixedActionParameterValues,
        opts.actionType
    );
    if (!fixedValues) return opts.parameters;

    const parameters = { ...opts.parameters };
    const resolving = new Set<string>();
    const resolved = new Map<string, unknown>();

    const resolveFixedParameter = (parameterName: string): unknown => {
        if (resolved.has(parameterName)) return resolved.get(parameterName);
        const fixedValue = fixedValues[parameterName];
        if (!fixedValue) return undefined;
        if (resolving.has(parameterName)) {
            throw new Error(`Circular fixed action parameter value for "${parameterName}".`);
        }
        resolving.add(parameterName);
        const value = evaluateExpression({
            expression: fixedValue,
            ctx: opts.ctx,
            parameters,
            resolveFixedParameter,
        });
        resolving.delete(parameterName);
        resolved.set(parameterName, value);
        return value;
    };

    for (const parameterName of Object.keys(fixedValues)) {
        parameters[parameterName] = resolveFixedParameter(parameterName);
    }

    return parameters;
}
