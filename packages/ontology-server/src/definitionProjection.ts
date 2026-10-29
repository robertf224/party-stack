import { isRelatedFromForeignKeySource, resolveRelatedLink } from "@party-stack/ontology/utils";
import type {
    ActionLogicStep,
    ActionTypeDef,
    Expression,
    OntologyDefinition,
    OntologyIR,
    PropertyAssignment,
    TypeDef,
    InputReferenceExpression,
} from "@party-stack/ontology";

export type FixedActionParameterValue = Expression;

export type FixedActionParameterValues<Ontology extends OntologyDefinition = OntologyDefinition> = {
    [ActionTypeName in Extract<keyof Ontology["actionTypes"], string>]?: {
        [
            ParameterName in Extract<keyof Ontology["actionTypes"][ActionTypeName]["parameters"], string>
        ]?: FixedActionParameterValue;
    };
};

type RuntimeFixedActionParameterValues = Record<
    string,
    Record<string, FixedActionParameterValue> | undefined
>;

function hasPath(value: unknown, path: string[]): boolean {
    let current = value;
    for (const segment of path) {
        if (typeof current !== "object" || current === null || !(segment in current)) return false;
        current = (current as Record<string, unknown>)[segment];
    }
    return true;
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

function getObjectReferenceObjectType(
    ir: OntologyIR,
    actionType: ActionTypeDef,
    reference: InputReferenceExpression
): string {
    const parameter = actionType.parameters.find((candidate) => candidate.name === reference.name);
    if (!parameter) {
        throw new Error(`Unknown action parameter "${reference.name}".`);
    }
    const type = resolveType(ir, parameter.type);
    if (type.kind !== "objectReference") {
        throw new Error(`Action parameter "${parameter.name}" is not an object reference.`);
    }
    return type.value.objectType;
}

function getFixedActionParameterValues(
    fixedActionParameterValues: FixedActionParameterValues | undefined,
    actionName: string
): Record<string, FixedActionParameterValue> | undefined {
    return (fixedActionParameterValues as RuntimeFixedActionParameterValues | undefined)?.[actionName];
}

function isActionParameterFixed(
    fixedActionParameterValues: FixedActionParameterValues | undefined,
    actionName: string,
    parameterName: string
): boolean {
    return (
        getFixedActionParameterValues(fixedActionParameterValues, actionName)?.[parameterName] !== undefined
    );
}

function getVisibleActionParameterNames(
    actionTypeName: string,
    parameters: ReadonlyArray<{ name: string }>,
    fixedActionParameterValues?: FixedActionParameterValues
): Set<string> {
    return new Set(
        parameters
            .filter(
                (parameter) =>
                    !isActionParameterFixed(fixedActionParameterValues, actionTypeName, parameter.name)
            )
            .map((parameter) => parameter.name)
    );
}

function getExpressionObjectType(
    ir: OntologyIR,
    actionName: string,
    expression: Expression
): string | undefined {
    if (expression.kind === "objectLookup") {
        const reference = expression.value.reference;
        if (reference.kind !== "inputReference") {
            return undefined;
        }
        const parameter = getActionType(ir, actionName).parameters.find(
            (candidate) => candidate.name === reference.value.name
        );
        if (!parameter) return undefined;
        let type = resolveType(ir, parameter.type);
        while (type.kind === "optional") {
            type = resolveType(ir, type.value.type);
        }
        return type.kind === "objectReference" ? type.value.objectType : undefined;
    }
    if (expression.kind === "related") {
        const sourceObjectType = getExpressionObjectType(ir, actionName, expression.value.source);
        if (!sourceObjectType) return undefined;
        const link = resolveRelatedLink(ir, sourceObjectType, expression.value.link);
        if (!link) return undefined;
        const foreignKeyOnSource = isRelatedFromForeignKeySource(
            link,
            sourceObjectType,
            expression.value.link
        );
        if (!foreignKeyOnSource && link.cardinality === "many") {
            return undefined;
        }
        return foreignKeyOnSource ? link.target.objectType : link.source.objectType;
    }
    return undefined;
}

function projectExpression(opts: {
    expression: Expression;

    context: Record<string, unknown> | undefined;

    ir: OntologyIR;
    actionName: string;
    visibleParameters: Set<string>;
    fixedActionParameterValues: FixedActionParameterValues | undefined;
    allowedObjectTypeProperties: Record<string, readonly string[]>;
    projectFixedParameterValues: boolean;
}): Expression | undefined {
    switch (opts.expression.kind) {
        case "contextReference":
            return hasPath(opts.context, [opts.expression.value.name]) ? opts.expression : undefined;
        case "literal":
        case "uuid":
        case "now":
        case "localReference":
            return opts.expression;
        case "getAt": {
            const objectType = getExpressionObjectType(
                opts.ir,
                opts.actionName,
                opts.expression.value.source
            );
            if (
                objectType &&
                !(opts.allowedObjectTypeProperties[objectType] ?? []).includes(opts.expression.value.path[0]!)
            ) {
                return undefined;
            }
            const source = projectExpression({
                ...opts,
                expression: opts.expression.value.source,
            });
            return source
                ? {
                      kind: "getAt",
                      value: {
                          source,
                          path: opts.expression.value.path,
                      },
                  }
                : undefined;
        }
        case "objectLookup": {
            const reference = projectExpression({
                ...opts,
                expression: opts.expression.value.reference,
            });
            return reference
                ? {
                      kind: "objectLookup",
                      value: { reference },
                  }
                : undefined;
        }
        case "related": {
            const source = projectExpression({
                ...opts,
                expression: opts.expression.value.source,
            });
            return source && getExpressionObjectType(opts.ir, opts.actionName, opts.expression)
                ? {
                      kind: "related",
                      value: {
                          source,
                          link: opts.expression.value.link,
                      },
                  }
                : undefined;
        }
        case "struct": {
            const fields = opts.expression.value.fields.map((field) => ({
                ...field,
                value: projectExpression({
                    ...opts,
                    expression: field.value,
                }),
            }));
            return fields.some((field) => field.value === undefined)
                ? undefined
                : {
                      kind: "struct",
                      value: {
                          fields: fields as Array<{
                              name: string;
                              value: Expression;
                          }>,
                      },
                  };
        }
        case "map": {
            const source = projectExpression({
                ...opts,
                expression: opts.expression.value.source,
            });
            const body = projectExpression({
                ...opts,
                expression: opts.expression.value.body,
            });
            return source && body
                ? {
                      kind: "map",
                      value: {
                          source,
                          binding: opts.expression.value.binding,
                          body,
                      },
                  }
                : undefined;
        }
        case "inputReference": {
            const parameterName = opts.expression.value.name;
            if (opts.visibleParameters.has(parameterName)) {
                return opts.expression;
            }
            if (!opts.projectFixedParameterValues) {
                return undefined;
            }
            const fixedValue = getFixedActionParameterValues(
                opts.fixedActionParameterValues,
                opts.actionName
            )?.[parameterName];
            if (fixedValue === undefined) return undefined;
            if (fixedValue.kind === "inputReference" && fixedValue.value.name === parameterName) {
                return undefined;
            }
            return projectExpression({
                ...opts,
                expression: fixedValue,
            });
        }
        case "case": {
            const branches = opts.expression.value.branches.map((branch) => ({
                condition: projectExpression({ ...opts, expression: branch.condition }),
                result: projectExpression({ ...opts, expression: branch.result }),
            }));
            const otherwise = projectExpression({ ...opts, expression: opts.expression.value.else });
            return otherwise && branches.every((b) => b.condition && b.result)
                ? {
                      kind: "case",
                      value: {
                          branches: branches as { condition: Expression; result: Expression }[],
                          else: otherwise,
                      },
                  }
                : undefined;
        }
        case "not": {
            const expression = projectExpression({ ...opts, expression: opts.expression.value.expression });
            return expression ? { kind: "not", value: { expression } } : undefined;
        }
        case "and":
        case "or":
        case "concat":
        case "coalesce": {
            const expressions = opts.expression.value.expressions.map((expression) =>
                projectExpression({ ...opts, expression })
            );
            return expressions.every((e) => e !== undefined)
                ? { kind: opts.expression.kind, value: { expressions: expressions as Expression[] } }
                : undefined;
        }
        case "eq":
        case "ne":
        case "lt":
        case "lte":
        case "gt":
        case "gte":
        case "in":
        case "contains":
        case "like":
        case "ilike":
        case "add":
        case "subtract":
        case "multiply":
        case "divide": {
            const left = projectExpression({ ...opts, expression: opts.expression.value.left });
            const right = projectExpression({ ...opts, expression: opts.expression.value.right });
            return left && right ? { kind: opts.expression.kind, value: { left, right } } : undefined;
        }
        case "exists":
            return undefined;
    }
}

function projectAssignments(opts: {
    assignments: PropertyAssignment[];

    context: Record<string, unknown> | undefined;

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

            context: opts.context,

            ir: opts.ir,
            actionName: opts.actionName,
            visibleParameters: opts.visibleParameters,
            fixedActionParameterValues: opts.fixedActionParameterValues,
            allowedObjectTypeProperties: opts.allowedObjectTypeProperties,
            projectFixedParameterValues: true,
        });
        return projectedValue ? [{ ...assignment, value: projectedValue }] : [];
    });
}

function projectLogicStep(opts: {
    step: ActionLogicStep;

    context: Record<string, unknown> | undefined;

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

                context: opts.context,

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
            const objectTypeName = getObjectReferenceObjectType(
                opts.ir,
                opts.actionType,
                opts.step.value.object
            );
            const values = projectAssignments({
                assignments: opts.step.value.values,

                context: opts.context,

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

function collectReferencedNamedTypes(
    type: TypeDef,
    ir: OntologyIR,
    into: Set<string>,
    seen = new Set<string>()
): void {
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
    visibleObjectTypes: Set<string>,
    visibleParameters?: Set<string>
): boolean {
    for (const parameter of actionType.parameters) {
        if (visibleParameters && !visibleParameters.has(parameter.name)) continue;
        for (const objectType of typeReferencesObjectTypes(parameter.type, ir)) {
            if (!visibleObjectTypes.has(objectType)) return true;
        }
    }
    return false;
}

export function projectOntologyDefinition<Ontology extends OntologyDefinition = OntologyDefinition>(opts: {
    ir: OntologyIR;

    context?: Record<string, unknown>;

    fixedActionParameterValues?: FixedActionParameterValues<Ontology>;
    projectFixedActionParameterValuesInDefaults?: boolean;
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

    const objectTypes = filterSchemaByAuthorization
        ? opts.ir.objectTypes
              .filter((objectType) => visibleObjectTypes.has(objectType.name))
              .map((objectType) => {
                  const allowed = new Set(opts.allowedObjectTypeProperties[objectType.name] ?? []);
                  return {
                      ...objectType,
                      title: objectType.title && allowed.has(objectType.title) ? objectType.title : undefined,
                      properties: objectType.properties.filter((property) => allowed.has(property.name)),
                  };
              })
        : opts.ir.objectTypes;

    const linkTypes = filterSchemaByAuthorization
        ? opts.ir.linkTypes.filter((link) => {
              if (
                  !visibleObjectTypes.has(link.source.objectType) ||
                  !visibleObjectTypes.has(link.target.objectType)
              ) {
                  return false;
              }
              if (!link.foreignKey) return true;
              const sourceAllowed = new Set(opts.allowedObjectTypeProperties[link.source.objectType] ?? []);
              const targetAllowed = new Set(opts.allowedObjectTypeProperties[link.target.objectType] ?? []);
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
                !actionParametersReferenceHiddenObjectType(
                    actionType,
                    opts.ir,
                    visibleObjectTypes,
                    getVisibleActionParameterNames(
                        actionType.name,
                        actionType.parameters,
                        opts.fixedActionParameterValues
                    )
                )
        )
        .map((actionType) => {
            const visibleParameters = getVisibleActionParameterNames(
                actionType.name,
                actionType.parameters,
                opts.fixedActionParameterValues
            );
            return {
                ...actionType,
                parameters: actionType.parameters
                    .filter((parameter) => visibleParameters.has(parameter.name))
                    .map((parameter) => ({
                        ...parameter,
                        defaultValue: parameter.defaultValue
                            ? projectExpression({
                                  expression: parameter.defaultValue,

                                  context: opts.context,

                                  ir: opts.ir,
                                  actionName: actionType.name,
                                  visibleParameters,
                                  fixedActionParameterValues: opts.fixedActionParameterValues,
                                  allowedObjectTypeProperties: opts.allowedObjectTypeProperties,
                                  projectFixedParameterValues:
                                      opts.projectFixedActionParameterValuesInDefaults ?? false,
                              })
                            : undefined,
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

                        context: opts.context,

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
    if (opts.ir.context?.type)
        collectReferencedNamedTypes(opts.ir.context.type, opts.ir, referencedNamedTypes);
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
