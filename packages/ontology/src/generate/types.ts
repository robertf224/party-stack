import { generateTypes as generateSchemaTypes } from "@party-stack/schema/generate";
import { pascalCase } from "change-case";
import { Project, Writers } from "ts-morph";
import type {
    FieldDef as SchemaFieldDef,
    SchemaIR,
    TypeDef as SchemaTypeDef,
    VariantDef as SchemaVariantDef,
} from "@party-stack/schema";
import type { ActionParameterDef, OntologyIR, ObjectTypeDef, PropertyDef, TypeDef } from "../ir/generated/types.js";

function renderPropertyName(name: string): string {
    return /^[$A-Z_][0-9A-Z_$]*$/i.test(name) ? name : JSON.stringify(name);
}

function lowerObjectReferenceType(
    objectTypeName: string,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): SchemaTypeDef {
    const objectType = objectTypes.get(objectTypeName)!;
    const primaryKey = objectType.properties.find((property) => property.name === objectType.primaryKey)!;
    return lowerType(primaryKey.type, objectTypes);
}

function lowerType(
    type: TypeDef,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): SchemaTypeDef {
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
        case "ref":
            return type;
        case "objectReference": {
            return lowerObjectReferenceType(type.value.objectType, objectTypes);
        }
        case "list":
            return {
                kind: "list",
                value: {
                    elementType: lowerType(type.value.elementType, objectTypes),
                },
            };
        case "map":
            return {
                kind: "map",
                value: {
                    keyType: lowerType(type.value.keyType, objectTypes),
                    valueType: lowerType(type.value.valueType, objectTypes),
                },
            };
        case "struct":
            return {
                kind: "struct",
                value: {
                    fields: type.value.fields.map(
                        (field): SchemaFieldDef => ({
                            ...field,
                            type: lowerType(field.type, objectTypes),
                        })
                    ),
                },
            };
        case "union":
            return {
                kind: "union",
                value: {
                    variants: type.value.variants.map(
                        (variant): SchemaVariantDef => ({
                            ...variant,
                            type: lowerType(variant.type, objectTypes),
                        })
                    ),
                },
            };
        case "optional":
            return {
                kind: "optional",
                value: { type: lowerType(type.value.type, objectTypes) },
            };
        case "result":
            return {
                kind: "result",
                value: {
                    okType: lowerType(type.value.okType, objectTypes),
                    errType: lowerType(type.value.errType, objectTypes),
                },
            };
    }
}

function lowerProperty(
    property: PropertyDef,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): SchemaFieldDef {
    return {
        name: property.name,
        displayName: property.displayName,
        description: property.description,
        deprecated: property.deprecated,
        type: lowerType(property.type, objectTypes),
    };
}

function lowerActionParameter(
    parameter: ActionParameterDef,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): SchemaFieldDef {
    const loweredType = lowerType(parameter.type, objectTypes);

    return {
        name: parameter.name,
        displayName: parameter.displayName,
        description: parameter.description,
        deprecated: parameter.deprecated,
        type:
            parameter.defaultValue !== undefined && loweredType.kind !== "optional"
                ? {
                      kind: "optional",
                      value: { type: loweredType },
                  }
                : loweredType,
    };
}

function toSchemaIR(ir: OntologyIR): SchemaIR {
    const objectTypes = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));

    return {
        types: [
            ...ir.types.map((type) => ({
                name: type.name,
                description: type.description,
                deprecated: type.deprecated,
                type: lowerType(type.type, objectTypes),
            })),
            ...ir.objectTypes.map((objectType) => ({
                name: objectType.name,
                description: objectType.description,
                deprecated: objectType.deprecated,
                type: {
                    kind: "struct" as const,
                    value: {
                        fields: objectType.properties.map((property) => lowerProperty(property, objectTypes)),
                    },
                },
            })),
            ...ir.actionTypes.map((actionType) => ({
                name: `${pascalCase(actionType.name)}Parameters`,
                description: actionType.description,
                deprecated: actionType.deprecated,
                type: {
                    kind: "struct" as const,
                    value: {
                        fields: actionType.parameters.map((parameter) =>
                            lowerActionParameter(parameter, objectTypes)
                        ),
                    },
                },
            })),
        ],
    };
}

export interface GenerateTypesOpts {
    outputTypeName?: string;
}

function addOntologyAggregateType(
    sourceFile: import("ts-morph").SourceFile,
    ir: OntologyIR,
    outputTypeName: string
): void {
    const properties = [
        {
            name: "objectTypes",
            type:
                ir.objectTypes.length === 0
                    ? "Record<never, never>"
                    : Writers.objectType({
                          properties: ir.objectTypes.map((objectType) => ({
                              name: renderPropertyName(objectType.name),
                              type: objectType.name,
                          })),
                      }),
        },
    ];

    properties.push({
        name: "actionTypes",
        type:
            ir.actionTypes.length === 0
                ? "Record<never, never>"
                : Writers.objectType({
                      properties: ir.actionTypes.map((action) => ({
                          name: renderPropertyName(action.name),
                          type: Writers.objectType({
                              properties: [
                                  {
                                      name: "parameters",
                                      type: `${pascalCase(action.name)}Parameters`,
                                  },
                              ],
                          }),
                      })),
                  }),
    });

    sourceFile.addTypeAlias({
        name: outputTypeName,
        isExported: true,
        type: Writers.objectType({ properties }),
    });
}

export function generateTypes(ir: OntologyIR, opts: GenerateTypesOpts = {}): string {
    const outputTypeName = opts.outputTypeName ?? "GeneratedOntology";
    const schemaTypes = generateSchemaTypes(toSchemaIR(ir));
    const project = new Project({ useInMemoryFileSystem: true });
    const aggregateFile = project.createSourceFile("ontology-aggregate.ts", "");
    addOntologyAggregateType(aggregateFile, ir, outputTypeName);
    return `${schemaTypes}\n\n${aggregateFile.getFullText().trim()}`.trim();
}
