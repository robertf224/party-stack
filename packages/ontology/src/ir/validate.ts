import type {
    ActionParameterDef,
    ActionTypeDef,
    Expression,
    ObjectTypeDef,
    OntologyIR,
    PropertyAssignment,
    PropertyDef,
    TypeDef,
    ValueReferenceExpression,
} from "./generated/types.js";

export type ValidationPathElement = string | number;

export interface ValidationError {
    path: ValidationPathElement[];
    message: string;
}

export type ValidationResult = { kind: "ok" } | { kind: "err"; errors: ValidationError[] };

function validateTypeDef(
    type: TypeDef,
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    switch (type.kind) {
        case "string":
        case "boolean":
        case "integer":
        case "float":
        case "double":
        case "date":
        case "timestamp":
        case "geopoint":
        case "attachment":
            return [];

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
            return validateTypeDef(type.value.elementType, [...path, "elementType"], valueTypeNames, objectTypeNames);

        case "map": {
            const errors: ValidationError[] = [];
            if (type.value.keyType.kind !== "string") {
                errors.push({
                    message: "Map key types must be string.",
                    path: [...path, "keyType"],
                });
            }
            return [
                ...errors,
                ...validateTypeDef(type.value.keyType, [...path, "keyType"], valueTypeNames, objectTypeNames),
                ...validateTypeDef(type.value.valueType, [...path, "valueType"], valueTypeNames, objectTypeNames),
            ];
        }

        case "struct":
            return validateStructFields(type.value.fields, [...path, "fields"], valueTypeNames, objectTypeNames);

        case "union":
            return validateUnionVariants(type.value.variants, [...path, "variants"], valueTypeNames, objectTypeNames);

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
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    const fieldNames = new Set<string>();
    const errors: ValidationError[] = [];

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
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    const seen = new Set<string>();
    const errors: ValidationError[] = [];

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

        errors.push(...validateTypeDef(variant.type, [...variantPath, "type"], valueTypeNames, objectTypeNames));
    }

    return errors;
}

function validateProperties(
    properties: PropertyDef[],
    path: ValidationPathElement[],
    valueTypeNames: Set<string>,
    objectTypeNames: Set<string>
): ValidationError[] {
    const names = new Set<string>();
    const errors: ValidationError[] = [];

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

function resolveParameterReferenceType(
    type: TypeDef,
    path: string[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
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
            return resolveParameterReferenceType(resolvedType.value.type, path, valueTypes, objectTypes);
        case "struct": {
            const field = resolvedType.value.fields.find((candidate) => candidate.name === segment);
            return field
                ? resolveParameterReferenceType(field.type, rest, valueTypes, objectTypes)
                : undefined;
        }
        case "objectReference": {
            const objectType = objectTypes.get(resolvedType.value.objectType);
            if (!objectType) {
                return undefined;
            }
            const property = objectType.properties.find((candidate) => candidate.name === segment);
            return property
                ? resolveParameterReferenceType(property.type, rest, valueTypes, objectTypes)
                : undefined;
        }
        default:
            return undefined;
    }
}

function validateExpression(
    expression: Expression,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    path: ValidationPathElement[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): ValidationError[] {
    switch (expression.kind) {
        case "valueReference": {
            if (expression.value.path.length === 0) {
                return [{ message: "Value references must include a parameter path.", path: [...path, "path"] }];
            }

            const [parameterName, ...parameterPath] = expression.value.path;
            const parameter = parameters.get(parameterName!);
            if (!parameter) {
                return [
                    {
                        message: `Unknown action parameter: "${parameterName}".`,
                        path: [...path, "path", 0],
                    },
                ];
            }

            return resolveParameterReferenceType(parameter.type, parameterPath, valueTypes, objectTypes)
                ? []
                : [
                      {
                          message: `Invalid value reference path on "${parameterName}".`,
                          path: [...path, "path"],
                      },
                  ];
        }
        case "contextReference":
            return expression.value.path.length > 0
                ? []
                : [{ message: "Context references must include a path.", path: [...path, "path"] }];
        case "functionCall":
            return [];
    }
}

function validateActionObjectReference(
    reference: ValueReferenceExpression,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    path: ValidationPathElement[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): { errors: ValidationError[]; objectType?: ObjectTypeDef } {
    if (reference.path.length !== 1) {
        return {
            errors: [
                {
                    message: "Action targets must point directly to an object reference parameter.",
                    path: [...path, "path"],
                },
            ],
        };
    }

    const [parameterName] = reference.path;
    const parameter = parameters.get(parameterName!);
    if (!parameter) {
        return {
            errors: [
                {
                    message: `Unknown action parameter: "${parameterName}".`,
                    path: [...path, "path", 0],
                },
            ],
        };
    }

    const resolved = resolveParameterReferenceType(parameter.type, [], valueTypes, objectTypes);
    if (!resolved || resolved.kind !== "objectReference") {
        return {
            errors: [
                {
                    message: `Action target parameter "${parameterName}" must be an object reference.`,
                    path: [...path, "path", 0],
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
                      path: [...path, "path", 0],
                  },
              ],
          };
}

function validateActionPropertyAssignment(
    assignment: PropertyAssignment,
    target: ObjectTypeDef,
    parameters: ReadonlyMap<string, ActionParameterDef>,
    path: ValidationPathElement[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): ValidationError[] {
    if (assignment.property.length === 0) {
        return [{ message: "Action property assignments must specify a property.", path: [...path, "property"] }];
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

    const resolved = resolveParameterReferenceType(property.type, rest, valueTypes, objectTypes);
    const errors = validateExpression(
        assignment.value,
        parameters,
        [...path, "value"],
        valueTypes,
        objectTypes
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
    path: ValidationPathElement[],
    valueTypes: ReadonlyMap<string, TypeDef>,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): ValidationError[] {
    const errors: ValidationError[] = [];
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
                    objectTypes
                )
            );
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
                            objectTypes
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
                            objectTypes
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

export function validate(ontology: OntologyIR): ValidationResult {
    const errors: ValidationError[] = [];

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

    // Validate value type definitions once both namespaces are known.
    for (let i = 0; i < ontology.types.length; i++) {
        const vt = ontology.types[i]!;
        errors.push(...validateTypeDef(vt.type, ["types", i, "type"], valueTypeNames, objectTypeNames));
    }

    // Validate object types
    for (let i = 0; i < ontology.objectTypes.length; i++) {
        const ot = ontology.objectTypes[i]!;
        const otPath = ["objectTypes", i] as ValidationPathElement[];

        // Validate properties
        errors.push(...validateProperties(ot.properties, [...otPath, "properties"], valueTypeNames, objectTypeNames));

        // Validate primary key references a valid property
        const propertyNames = new Set(ot.properties.map((p) => p.name));
        if (!propertyNames.has(ot.primaryKey)) {
            errors.push({
                message: `Primary key "${ot.primaryKey}" does not reference a valid property.`,
                path: [...otPath, "primaryKey"],
            });
        }
    }

    // Validate link types
    const linkIds = new Set<string>();
    const linkNames = new Set<string>();
    for (let i = 0; i < ontology.linkTypes.length; i++) {
        const lt = ontology.linkTypes[i]!;
        const ltPath = ["linkTypes", i] as ValidationPathElement[];

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
    }

    const actionNames = new Set<string>();
    for (let i = 0; i < ontology.actionTypes.length; i++) {
        const action = ontology.actionTypes[i]!;
        const actionPath = ["actionTypes", i] as ValidationPathElement[];

        if (actionNames.has(action.name)) {
            errors.push({
                message: `Duplicate action type name: "${action.name}".`,
                path: [...actionPath, "name"],
            });
        }
        actionNames.add(action.name);

        errors.push(...validateAction(action, actionPath, valueTypes, objectTypes));
    }

    return errors.length === 0 ? { kind: "ok" } : { kind: "err", errors };
}
