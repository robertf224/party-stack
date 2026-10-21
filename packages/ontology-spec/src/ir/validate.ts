import { isLinkHopFromForeignKeySource, resolveLinkHop } from "../utils/links.js";
import { unwrapType } from "../utils/types.js";
import { ImageMediaTypeOptions } from "./generated/constants.js";
import type { ValidationIssue } from "../utils/validation.js";
import type { Result } from "../utils/values.js";
import type {
    ActionParameterDef,
    ActionTypeDef,
    Expression,
    LinkTypeDef,
    ObjectTypeDef,
    OntologyIR,
    PropertyAssignment,
    PropertyDef,
    QueryFunctionTypeDef,
    TypeDef,
    InputReferenceExpression,
} from "./generated/types.js";

export type ValidationResult = Result<void, ValidationIssue[]>;

// TODO: Replace this attachment-specific range validation with real numeric constraints in the meta ontology.
function validateNonNegativeRange(
    range: { min?: number; max?: number } | undefined,
    path: (string | number)[]
): ValidationIssue[] {
    if (!range) return [];
    const errors: ValidationIssue[] = [];
    for (const bound of ["min", "max"] as const) {
        const value = range[bound];
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
            errors.push({
                message: `Range ${bound} must be a finite, non-negative number.`,
                path: [...path, bound],
            });
        }
    }
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
        errors.push({
            message: "Range min must be less than or equal to max.",
            path,
        });
    }
    return errors;
}

function validateAttachmentConstraints(type: Extract<TypeDef, { kind: "attachment" }>): ValidationIssue[] {
    const constraint = type.value.constraint;
    if (!constraint) return [];

    const errors = validateNonNegativeRange(constraint.size, ["constraint", "size"]);
    const content = constraint.content;
    if (content?.kind !== "image") return errors;

    for (const [index, mediaType] of (content.value.mediaTypes ?? []).entries()) {
        if (!ImageMediaTypeOptions.some((option) => option.value === mediaType)) {
            errors.push({
                message: `Unsupported image media type: "${mediaType}".`,
                path: ["constraint", "content", "value", "mediaTypes", index],
            });
        }
    }
    errors.push(
        ...validateNonNegativeRange(content.value.dimensions?.width, [
            "constraint",
            "content",
            "value",
            "dimensions",
            "width",
        ]),
        ...validateNonNegativeRange(content.value.dimensions?.height, [
            "constraint",
            "content",
            "value",
            "dimensions",
            "height",
        ])
    );
    return errors;
}

function validateTypeDef(
    type: TypeDef,
    path: (string | number)[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationIssue[] {
    switch (type.kind) {
        case "string":
        case "boolean":
        case "integer":
        case "float":
        case "double":
        case "date":
        case "timestamp":
        case "geopoint":
        case "unknown":
            return [];

        case "attachment":
            return validateAttachmentConstraints(type).map((error) => ({
                ...error,
                path: [...path, ...(error.path ?? [])],
            }));

        case "objectReference":
            return objectTypeNames.has(type.value.objectType)
                ? []
                : [
                      {
                          message: `Unknown object type reference: "${type.value.objectType}".`,
                          path: [...path, "objectType"],
                      },
                  ];

        case "list":
            return validateTypeDef(
                type.value.elementType,
                [...path, "elementType"],
                valueTypeNames,
                objectTypeNames
            );

        case "map": {
            const errors: ValidationIssue[] = [];
            if (type.value.keyType.kind !== "string") {
                errors.push({
                    message: "Map key types must be string.",
                    path: [...path, "keyType"],
                });
            }
            return [
                ...errors,
                ...validateTypeDef(type.value.keyType, [...path, "keyType"], valueTypeNames, objectTypeNames),
                ...validateTypeDef(
                    type.value.valueType,
                    [...path, "valueType"],
                    valueTypeNames,
                    objectTypeNames
                ),
            ];
        }

        case "struct":
            return validateStructFields(
                type.value.fields,
                [...path, "fields"],
                valueTypeNames,
                objectTypeNames
            );

        case "union":
            return validateUnionVariants(
                type.value.variants,
                [...path, "variants"],
                valueTypeNames,
                objectTypeNames
            );

        case "encrypted":
        case "optional":
            return validateTypeDef(type.value.type, [...path, "type"], valueTypeNames, objectTypeNames);

        case "result":
            return [
                ...validateTypeDef(type.value.okType, [...path, "okType"], valueTypeNames, objectTypeNames),
                ...validateTypeDef(type.value.errType, [...path, "errType"], valueTypeNames, objectTypeNames),
            ];

        case "ref":
            return valueTypeNames.has(type.value.name)
                ? []
                : [
                      {
                          message: `Unknown value type reference: "${type.value.name}".`,
                          path: [...path, "name"],
                      },
                  ];
    }
}

function validateStructFields(
    fields: Array<{ name: string; displayName: string; type: TypeDef }>,
    path: (string | number)[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationIssue[] {
    const fieldNames = new Set<string>();
    const errors: ValidationIssue[] = [];

    for (let i = 0; i < fields.length; i++) {
        const field = fields[i]!;
        const fieldPath = [...path, i];

        if (fieldNames.has(field.name)) {
            errors.push({ message: `Duplicate field name: "${field.name}".`, path: [...fieldPath, "name"] });
        }
        fieldNames.add(field.name);

        errors.push(...validateTypeDef(field.type, [...fieldPath, "type"], valueTypeNames, objectTypeNames));
    }

    return errors;
}

function validateUnionVariants(
    variants: Array<{ name: string; type: TypeDef }>,
    path: (string | number)[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationIssue[] {
    const seen = new Set<string>();
    const errors: ValidationIssue[] = [];

    for (let i = 0; i < variants.length; i++) {
        const variant = variants[i]!;
        const variantPath = [...path, i];

        if (seen.has(variant.name)) {
            errors.push({
                message: `Duplicate variant name: "${variant.name}".`,
                path: [...variantPath, "name"],
            });
        }
        seen.add(variant.name);

        errors.push(
            ...validateTypeDef(variant.type, [...variantPath, "type"], valueTypeNames, objectTypeNames)
        );
    }

    return errors;
}

function validateProperties(
    properties: PropertyDef[],
    path: (string | number)[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationIssue[] {
    const names = new Set<string>();
    const errors: ValidationIssue[] = [];

    for (let i = 0; i < properties.length; i++) {
        const prop = properties[i]!;
        const propPath = [...path, i];

        if (names.has(prop.name)) {
            errors.push({
                message: `Duplicate property name: "${prop.name}".`,
                path: [...propPath, "name"],
            });
        }
        names.add(prop.name);

        errors.push(...validateTypeDef(prop.type, [...propPath, "type"], valueTypeNames, objectTypeNames));
    }

    return errors;
}

function resolveType(
    type: TypeDef,
    valueTypes: ReadonlyMap<string, TypeDef>,
    seen = new Set<string>()
): TypeDef | undefined {
    if (type.kind !== "ref") {
        return type;
    }

    const name = type.value.name;
    if (seen.has(name)) {
        return undefined;
    }

    const resolved = valueTypes.get(name);
    if (!resolved) {
        return undefined;
    }

    return resolveType(resolved, valueTypes, new Set([...seen, name]));
}

function resolveFieldType(
    type: TypeDef,
    path: string[],
    valueTypes: ReadonlyMap<string, TypeDef>
): TypeDef | undefined {
    const resolvedType = resolveType(type, valueTypes);
    if (!resolvedType) {
        return undefined;
    }

    if (path.length === 0) {
        return resolvedType;
    }

    const [segment, ...rest] = path;

    switch (resolvedType.kind) {
        case "optional":
            return resolveFieldType(resolvedType.value.type, path, valueTypes);
        case "struct": {
            const field = resolvedType.value.fields.find((candidate) => candidate.name === segment);
            return field ? resolveFieldType(field.type, rest, valueTypes) : undefined;
        }
        default:
            return undefined;
    }
}

type ExpressionValueType =
    | TypeDef
    | {
          kind: "ontologyObject";
          objectType: string;
      };

function resolveExpressionType(
    expression: Expression,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>,
    linkTypes: readonly LinkTypeDef[],
    contextType: TypeDef | undefined,
    locals: ReadonlyMap<string, TypeDef>
): ExpressionValueType | undefined {
    switch (expression.kind) {
        case "inputReference":
            return parameters.get(expression.value.name)?.type;
        case "contextReference":
            return contextType
                ? resolveFieldType(contextType, [expression.value.name], valueTypes)
                : undefined;
        case "localReference":
            return locals.get(expression.value.name);
        case "getAt": {
            const sourceType = resolveExpressionType(
                expression.value.source,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            if (!sourceType || expression.value.path.length === 0) {
                return undefined;
            }
            if (sourceType.kind === "ontologyObject") {
                const [propertyName, ...rest] = expression.value.path;
                const property = objectTypes
                    .get(sourceType.objectType)
                    ?.properties.find((candidate) => candidate.name === propertyName);
                return property ? resolveFieldType(property.type, rest, valueTypes) : undefined;
            }
            return resolveFieldType(sourceType, expression.value.path, valueTypes);
        }
        case "objectLookup": {
            const referenceType = resolveExpressionType(
                expression.value.reference,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            const resolved =
                referenceType?.kind === "ontologyObject"
                    ? undefined
                    : referenceType
                      ? unwrapOptionalType(referenceType, valueTypes)
                      : undefined;
            return resolved?.kind === "objectReference"
                ? {
                      kind: "ontologyObject",
                      objectType: resolved.value.objectType,
                  }
                : undefined;
        }
        case "linkHop": {
            const sourceType = resolveExpressionType(
                expression.value.source,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            if (sourceType?.kind !== "ontologyObject") {
                return undefined;
            }
            const link = resolveLinkHop(
                {
                    objectTypes: [...objectTypes.values()],
                    linkTypes: [...linkTypes],
                },
                sourceType.objectType,
                expression.value.link
            );
            if (!link) return undefined;
            const foreignKeyOnSource = isLinkHopFromForeignKeySource(
                link,
                sourceType.objectType,
                expression.value.link
            );
            if (!foreignKeyOnSource && link.cardinality === "many") {
                return undefined;
            }
            return {
                kind: "ontologyObject",
                objectType: foreignKeyOnSource ? link.target.objectType : link.source.objectType,
            };
        }
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: expression.value.fields.map((field) => ({
                        name: field.name,
                        displayName: field.name,
                        type: (() => {
                            const resolved = resolveExpressionType(
                                field.value,
                                parameters,
                                valueTypes,
                                objectTypes,
                                linkTypes,
                                contextType,
                                locals
                            );
                            return resolved && resolved.kind !== "ontologyObject"
                                ? resolved
                                : {
                                      kind: "unknown" as const,
                                      value: {},
                                  };
                        })(),
                    })),
                },
            };
        case "map": {
            const sourceType = resolveExpressionType(
                expression.value.source,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            const listType =
                sourceType && sourceType.kind !== "ontologyObject"
                    ? unwrapOptionalType(sourceType, valueTypes)
                    : undefined;
            if (listType?.kind !== "list") {
                return undefined;
            }
            const bodyLocals = new Map(locals);
            bodyLocals.set(expression.value.binding, listType.value.elementType);
            const bodyType = resolveExpressionType(
                expression.value.body,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                bodyLocals
            );
            return bodyType && bodyType.kind !== "ontologyObject"
                ? {
                      kind: "list",
                      value: { elementType: bodyType },
                  }
                : undefined;
        }
        case "literal":
            return { kind: "unknown", value: {} };
        case "uuid":
            return { kind: "string", value: {} };
        case "now":
            return { kind: "timestamp", value: {} };
    }
}

function validateExpression(
    expression: Expression,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    path: (string | number)[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>,
    linkTypes: readonly LinkTypeDef[],
    contextType: TypeDef | undefined,
    locals: ReadonlyMap<string, TypeDef> = new Map()
): ValidationIssue[] {
    switch (expression.kind) {
        case "inputReference": {
            const parameter = parameters.get(expression.value.name);
            if (!parameter) {
                return [
                    {
                        message: `Unknown action parameter: "${expression.value.name}".`,
                        path: [...path, "name"],
                    },
                ];
            }
            return [];
        }
        case "contextReference":
            if (!contextType) {
                return [];
            }
            return resolveFieldType(contextType, [expression.value.name], valueTypes)
                ? []
                : [
                      {
                          message: `Unknown context value: "${expression.value.name}".`,
                          path: [...path, "name"],
                      },
                  ];
        case "localReference": {
            const local = locals.get(expression.value.name);
            if (!local) {
                return [
                    {
                        message: `Unknown expression binding: "${expression.value.name}".`,
                        path: [...path, "name"],
                    },
                ];
            }
            return [];
        }
        case "getAt":
        case "objectLookup":
        case "linkHop": {
            const childKey = expression.kind === "objectLookup" ? "reference" : "source";
            const child =
                expression.kind === "objectLookup" ? expression.value.reference : expression.value.source;
            const errors = validateExpression(
                child,
                parameters,
                [...path, childKey],
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            if (expression.kind === "getAt" && expression.value.path.length === 0) {
                errors.push({
                    message: "Get-at expression paths must not be empty.",
                    path: [...path, "path"],
                });
            }
            const resolved = resolveExpressionType(
                expression,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            if (!resolved) {
                errors.push({
                    message:
                        expression.kind === "getAt"
                            ? "Get-at expression source and path must resolve structurally."
                            : expression.kind === "objectLookup"
                              ? "Object lookup references must resolve to an object reference."
                              : "Link hop must resolve to a named to-one link.",
                    path,
                });
            }
            return errors;
        }
        case "struct": {
            const errors: ValidationIssue[] = [];
            const names = new Set<string>();
            for (let index = 0; index < expression.value.fields.length; index++) {
                const field = expression.value.fields[index]!;
                if (names.has(field.name)) {
                    errors.push({
                        message: `Duplicate struct expression field: "${field.name}".`,
                        path: [...path, "fields", index, "name"],
                    });
                }
                names.add(field.name);
                errors.push(
                    ...validateExpression(
                        field.value,
                        parameters,
                        [...path, "fields", index, "value"],
                        valueTypes,
                        objectTypes,
                        linkTypes,
                        contextType,
                        locals
                    )
                );
            }
            return errors;
        }
        case "map": {
            const errors = validateExpression(
                expression.value.source,
                parameters,
                [...path, "source"],
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            const sourceType = resolveExpressionType(
                expression.value.source,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                locals
            );
            const listType =
                sourceType && sourceType.kind !== "ontologyObject"
                    ? unwrapOptionalType(sourceType, valueTypes)
                    : undefined;
            if (sourceType && listType?.kind !== "list") {
                errors.push({
                    message: "Map expression source must resolve to a list.",
                    path: [...path, "source"],
                });
            }
            if (!expression.value.binding) {
                errors.push({
                    message: "Map expression binding must not be empty.",
                    path: [...path, "binding"],
                });
            }
            const bodyLocals = new Map(locals);
            bodyLocals.set(
                expression.value.binding,
                listType?.kind === "list" ? listType.value.elementType : { kind: "unknown", value: {} }
            );
            errors.push(
                ...validateExpression(
                    expression.value.body,
                    parameters,
                    [...path, "body"],
                    valueTypes,
                    objectTypes,
                    linkTypes,
                    contextType,
                    bodyLocals
                )
            );
            return errors;
        }
        case "uuid":
        case "now":
        case "literal":
            return [];
    }
}

function unwrapOptionalType(type: TypeDef, valueTypes: ReadonlyMap<string, TypeDef>): TypeDef | undefined {
    const resolved = resolveType(type, valueTypes);
    return resolved?.kind === "optional" ? unwrapOptionalType(resolved.value.type, valueTypes) : resolved;
}

function areDefaultTypesCompatible(
    target: TypeDef,
    source: TypeDef,
    valueTypes: ReadonlyMap<string, TypeDef>
): boolean {
    const targetType = unwrapOptionalType(target, valueTypes);
    const sourceType = unwrapOptionalType(source, valueTypes);
    if (!targetType || !sourceType) return false;
    if (targetType.kind === "unknown" || sourceType.kind === "unknown") return true;
    if (targetType.kind !== sourceType.kind) return false;
    if (targetType.kind === "objectReference" && sourceType.kind === "objectReference") {
        return targetType.value.objectType === sourceType.value.objectType;
    }
    if (targetType.kind === "list" && sourceType.kind === "list") {
        return areDefaultTypesCompatible(
            targetType.value.elementType,
            sourceType.value.elementType,
            valueTypes
        );
    }
    return true;
}

function validateActionObjectReference(
    reference: InputReferenceExpression,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    path: (string | number)[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): { errors: ValidationIssue[]; objectType?: ObjectTypeDef } {
    const parameterName = reference.name;
    const parameter = parameters.get(parameterName);
    if (!parameter) {
        return {
            errors: [
                {
                    message: `Unknown action parameter: "${parameterName}".`,
                    path: [...path, "name"],
                },
            ],
        };
    }

    const resolved = resolveType(parameter.type, valueTypes);
    if (!resolved || resolved.kind !== "objectReference") {
        return {
            errors: [
                {
                    message: `Action target parameter "${parameterName}" must be an object reference.`,
                    path: [...path, "name"],
                },
            ],
        };
    }

    const targetObjectType = objectTypes.get(resolved.value.objectType);
    return targetObjectType
        ? { errors: [], objectType: targetObjectType }
        : {
              errors: [
                  {
                      message: `Unknown object type reference: "${resolved.value.objectType}".`,
                      path: [...path, "name"],
                  },
              ],
          };
}

function validateActionPropertyAssignment(
    assignment: PropertyAssignment,
    target: ObjectTypeDef,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    path: (string | number)[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>,
    linkTypes: readonly LinkTypeDef[],
    contextType: TypeDef | undefined
): ValidationIssue[] {
    if (assignment.property.length === 0) {
        return [
            { message: "Action property assignments must specify a property.", path: [...path, "property"] },
        ];
    }

    const [propertyName, ...rest] = assignment.property;
    const property = target.properties.find((candidate) => candidate.name === propertyName);
    if (!property) {
        return [
            {
                message: `Unknown property "${propertyName}" on object type "${target.name}".`,
                path: [...path, "property"],
            },
        ];
    }

    const resolved = resolveFieldType(property.type, rest, valueTypes);
    const errors = validateExpression(
        assignment.value,
        parameters,
        [...path, "value"],
        valueTypes,
        objectTypes,
        linkTypes,
        contextType
    );

    return resolved
        ? errors
        : [
              ...errors,
              {
                  message: `Invalid property "${assignment.property.join(".")}" on object type "${target.name}".`,
                  path: [...path, "property"],
              },
          ];
}

function validateAction(
    action: ActionTypeDef,
    path: (string | number)[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>,
    linkTypes: readonly LinkTypeDef[],
    contextType: TypeDef | undefined
): ValidationIssue[] {
    const errors: ValidationIssue[] = [];
    const parameters = new Map(action.parameters.map((parameter) => [parameter.name, parameter]));
    const seenParameters = new Set<string>();

    for (let index = 0; index < action.parameters.length; index++) {
        const parameter = action.parameters[index]!;
        const parameterPath = [...path, "parameters", index];

        if (seenParameters.has(parameter.name)) {
            errors.push({
                message: `Duplicate action parameter name: "${parameter.name}".`,
                path: [...parameterPath, "name"],
            });
        }
        seenParameters.add(parameter.name);

        errors.push(
            ...validateTypeDef(
                parameter.type,
                [...parameterPath, "type"],
                new Set(valueTypes.keys()),
                new Set(objectTypes.keys())
            )
        );

        if (parameter.defaultValue) {
            errors.push(
                ...validateExpression(
                    parameter.defaultValue,
                    parameters,
                    [...parameterPath, "defaultValue"],
                    valueTypes,
                    objectTypes,
                    linkTypes,
                    contextType
                )
            );
            const sourceType = resolveExpressionType(
                parameter.defaultValue,
                parameters,
                valueTypes,
                objectTypes,
                linkTypes,
                contextType,
                new Map()
            );
            if (
                sourceType &&
                sourceType.kind !== "ontologyObject" &&
                !areDefaultTypesCompatible(parameter.type, sourceType, valueTypes)
            ) {
                errors.push({
                    message: `Default value for "${parameter.name}" has an incompatible type.`,
                    path: [...parameterPath, "defaultValue"],
                });
            }
        }
    }

    for (let index = 0; index < action.logic.length; index++) {
        const step = action.logic[index]!;
        const stepPath = [...path, "logic", index];

        switch (step.kind) {
            case "createObject": {
                const objectType = objectTypes.get(step.value.objectType);
                if (!objectType) {
                    errors.push({
                        message: `Unknown object type "${step.value.objectType}" in action "${action.name}".`,
                        path: [...stepPath, "value", "objectType"],
                    });
                    continue;
                }
                for (let valueIndex = 0; valueIndex < step.value.values.length; valueIndex++) {
                    errors.push(
                        ...validateActionPropertyAssignment(
                            step.value.values[valueIndex]!,
                            objectType,
                            parameters,
                            [...stepPath, "value", "values", valueIndex],
                            valueTypes,
                            objectTypes,
                            linkTypes,
                            contextType
                        )
                    );
                }
                break;
            }
            case "updateObject": {
                const target = validateActionObjectReference(
                    step.value.object,
                    parameters,
                    [...stepPath, "value", "object"],
                    valueTypes,
                    objectTypes
                );
                errors.push(...target.errors);
                if (!target.objectType) {
                    continue;
                }
                for (let valueIndex = 0; valueIndex < step.value.values.length; valueIndex++) {
                    errors.push(
                        ...validateActionPropertyAssignment(
                            step.value.values[valueIndex]!,
                            target.objectType,
                            parameters,
                            [...stepPath, "value", "values", valueIndex],
                            valueTypes,
                            objectTypes,
                            linkTypes,
                            contextType
                        )
                    );
                }
                break;
            }
            case "deleteObject":
                errors.push(
                    ...validateActionObjectReference(
                        step.value.object,
                        parameters,
                        [...stepPath, "value", "object"],
                        valueTypes,
                        objectTypes
                    ).errors
                );
                break;
        }
    }

    return errors;
}

function validateQueryFunctionType(
    queryFunctionType: QueryFunctionTypeDef,
    path: (string | number)[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationIssue[] {
    const errors: ValidationIssue[] = [];
    const seenParameters = new Set<string>();

    for (let index = 0; index < queryFunctionType.parameters.length; index++) {
        const parameter = queryFunctionType.parameters[index]!;
        const parameterPath = [...path, "parameters", index];

        if (seenParameters.has(parameter.name)) {
            errors.push({
                message: `Duplicate query function parameter name: "${parameter.name}".`,
                path: [...parameterPath, "name"],
            });
        }
        seenParameters.add(parameter.name);

        errors.push(
            ...validateTypeDef(parameter.type, [...parameterPath, "type"], valueTypeNames, objectTypeNames)
        );
    }

    errors.push(
        ...validateTypeDef(
            queryFunctionType.returnType,
            [...path, "returnType"],
            valueTypeNames,
            objectTypeNames
        )
    );

    return errors;
}

export function validate(ontology: OntologyIR): ValidationResult {
    const errors: ValidationIssue[] = [];

    // Collect value type names for ref resolution
    const valueTypeNames = new Set<string>();
    for (let i = 0; i < ontology.types.length; i++) {
        const vt = ontology.types[i]!;
        if (valueTypeNames.has(vt.name)) {
            errors.push({
                message: `Duplicate value type name: "${vt.name}".`,
                path: ["types", i, "name"],
            });
        }
        valueTypeNames.add(vt.name);
    }

    const objectTypeNames = new Set<string>();
    for (let i = 0; i < ontology.objectTypes.length; i++) {
        const ot = ontology.objectTypes[i]!;
        if (objectTypeNames.has(ot.name)) {
            errors.push({
                message: `Duplicate object type name: "${ot.name}".`,
                path: ["objectTypes", i, "name"],
            });
        }
        objectTypeNames.add(ot.name);
    }

    const valueTypes = new Map(ontology.types.map((type) => [type.name, type.type]));
    const objectTypes = new Map(ontology.objectTypes.map((objectType) => [objectType.name, objectType]));

    if (ontology.contextType) {
        errors.push(
            ...validateTypeDef(ontology.contextType, ["contextType"], valueTypeNames, objectTypeNames)
        );
        const resolvedContextType = resolveType(ontology.contextType, valueTypes);
        if (resolvedContextType?.kind === "struct") {
            const userField = resolvedContextType.value.fields.find((field) => field.name === "user");
            const unwrappedUserType = userField ? unwrapType(userField.type).type : undefined;
            const resolvedUserType = unwrappedUserType
                ? resolveType(unwrappedUserType, valueTypes)
                : undefined;
            if (userField && resolvedUserType?.kind !== "objectReference") {
                errors.push({
                    message: 'Reserved context field "user" must be an object reference.',
                    path: [
                        "contextType",
                        "fields",
                        resolvedContextType.value.fields.indexOf(userField),
                        "type",
                    ],
                });
            }
        }
    }

    // Validate value type definitions once both namespaces are known.
    for (let i = 0; i < ontology.types.length; i++) {
        const vt = ontology.types[i]!;
        errors.push(...validateTypeDef(vt.type, ["types", i, "type"], valueTypeNames, objectTypeNames));
    }

    // Validate object types
    for (let i = 0; i < ontology.objectTypes.length; i++) {
        const ot = ontology.objectTypes[i]!;
        const otPath = ["objectTypes", i] as (string | number)[];

        // Validate properties
        errors.push(
            ...validateProperties(ot.properties, [...otPath, "properties"], valueTypeNames, objectTypeNames)
        );

        // Validate primary key references a valid property
        const propertyNames = new Set(ot.properties.map((p) => p.name));
        if (!propertyNames.has(ot.primaryKey)) {
            errors.push({
                message: `Primary key "${ot.primaryKey}" does not reference a valid property.`,
                path: [...otPath, "primaryKey"],
            });
        }
        if (ot.title && !propertyNames.has(ot.title)) {
            errors.push({
                message: `Title "${ot.title}" does not reference a valid property.`,
                path: [...otPath, "title"],
            });
        }
    }

    // Validate link types
    const linkIds = new Set<string>();
    const linkNames = new Set<string>();
    for (let i = 0; i < ontology.linkTypes.length; i++) {
        const lt = ontology.linkTypes[i]!;
        const ltPath = ["linkTypes", i] as (string | number)[];

        if (linkIds.has(lt.id)) {
            errors.push({
                message: `Duplicate link type id: "${lt.id}".`,
                path: [...ltPath, "id"],
            });
        }
        linkIds.add(lt.id);

        // Relationship names from a source object are keyed by target.name.
        const linkName = `${lt.source.objectType}:${lt.target.name}`;
        if (linkNames.has(linkName)) {
            errors.push({
                message: `Duplicate link type target name: "${lt.target.name}" on "${lt.source.objectType}".`,
                path: [...ltPath, "target", "name"],
            });
        }
        linkNames.add(linkName);

        if (!objectTypeNames.has(lt.source.objectType)) {
            errors.push({
                message: `Source object type "${lt.source.objectType}" does not exist.`,
                path: [...ltPath, "source", "objectType"],
            });
        }

        if (!objectTypeNames.has(lt.target.objectType)) {
            errors.push({
                message: `Target object type "${lt.target.objectType}" does not exist.`,
                path: [...ltPath, "target", "objectType"],
            });
        }

        const foreignKeyRoot = lt.foreignKey.split(".")[0]!;
        const sourceType = ontology.objectTypes.find((candidate) => candidate.name === lt.source.objectType);
        const sourceHasFk =
            sourceType?.properties.some((property) => property.name === foreignKeyRoot) ?? false;
        if (sourceType && !sourceHasFk) {
            errors.push({
                message: `Foreign key "${lt.foreignKey}" does not exist on source object type "${lt.source.objectType}" for link "${lt.id}".`,
                path: [...ltPath, "foreignKey"],
            });
        }
    }

    const actionNames = new Set<string>();
    for (let i = 0; i < ontology.actionTypes.length; i++) {
        const action = ontology.actionTypes[i]!;
        const actionPath = ["actionTypes", i] as (string | number)[];

        if (actionNames.has(action.name)) {
            errors.push({
                message: `Duplicate action type name: "${action.name}".`,
                path: [...actionPath, "name"],
            });
        }
        actionNames.add(action.name);

        errors.push(
            ...validateAction(
                action,
                actionPath,
                valueTypes,
                objectTypes,
                ontology.linkTypes,
                ontology.contextType
            )
        );
    }

    const queryFunctionTypeNames = new Set<string>();
    for (let i = 0; i < ontology.queryFunctionTypes.length; i++) {
        const queryFunctionType = ontology.queryFunctionTypes[i]!;
        const queryFunctionTypePath = ["queryFunctionTypes", i] as (string | number)[];

        if (queryFunctionTypeNames.has(queryFunctionType.name)) {
            errors.push({
                message: `Duplicate query function type name: "${queryFunctionType.name}".`,
                path: [...queryFunctionTypePath, "name"],
            });
        }
        queryFunctionTypeNames.add(queryFunctionType.name);

        errors.push(
            ...validateQueryFunctionType(
                queryFunctionType,
                queryFunctionTypePath,
                valueTypeNames,
                objectTypeNames
            )
        );
    }

    return errors.length === 0 ? { kind: "ok", value: undefined } : { kind: "err", value: errors };
}
