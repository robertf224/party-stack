import { s } from "@party-stack/schema";
import { generateForTypeDef, generateTypes as generateSchemaTypes } from "@party-stack/schema/generate";
import { pascalCase } from "change-case";
import { CodeBlockWriter, Project, Writers, type WriterFunction } from "ts-morph";
import type {
    FieldDef as SchemaFieldDef,
    NamedTypeDef as SchemaNamedTypeDef,
    SchemaIR,
    TypeDef as SchemaTypeDef,
    VariantDef as SchemaVariantDef,
} from "@party-stack/schema";
import type { OntologyIR, ObjectTypeDef, PropertyDef, TypeDef } from "../ir/generated/types.js";

function withWriter(fn: WriterFunction): string {
    const writer = new CodeBlockWriter();
    fn(writer);
    return writer.toString();
}

function union(options: string[]): string {
    if (options.length === 0) {
        return "never";
    }
    if (options.length === 1) {
        return options[0]!;
    }
    return withWriter(Writers.unionType(options[0]!, options[1]!, ...options.slice(2)));
}

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

function lowerAttachmentType(): SchemaTypeDef {
    return s.ref({ name: "attachment" });
}

function attachmentSchemaType(): SchemaNamedTypeDef {
    return {
        name: "attachment",
        type: s.struct({
            fields: [
                { name: "id", displayName: "ID", type: s.string({}) },
                { name: "size", displayName: "Size", type: s.optional({ type: s.double({}) }) },
                { name: "type", displayName: "Type", type: s.optional({ type: s.string({}) }) },
                { name: "name", displayName: "Name", type: s.optional({ type: s.string({}) }) },
            ],
        }),
    };
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
        case "ref":
        case "unknown":
            return type;
        case "attachment":
            return lowerAttachmentType();
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

function toSchemaIR(ir: OntologyIR): SchemaIR {
    const objectTypes = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));

    return {
        types: [
            attachmentSchemaType(),
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

function addActionParameterTypes(sourceFile: import("ts-morph").SourceFile, ir: OntologyIR): void {
    const objectTypes = new Map(ir.objectTypes.map((objectType) => [objectType.name, objectType]));
    for (const actionType of ir.actionTypes) {
        sourceFile.addTypeAlias({
            name: `${pascalCase(actionType.name)}Parameters`,
            isExported: true,
            type: withWriter(
                Writers.objectType({
                    properties: actionType.parameters.map((parameter) => {
                        const parameterType = parameter.type;
                        const isOptional = parameterType.kind === "optional";
                        const type = isOptional ? parameterType.value.type : parameterType;
                        const renderedType = generateForTypeDef(lowerType(type, objectTypes));
                        return {
                            name: renderPropertyName(parameter.name),
                            type: isOptional ? union([renderedType, "null"]) : renderedType,
                            hasQuestionToken: isOptional || parameter.defaultValue !== undefined,
                        };
                    }),
                })
            ),
        });
    }
}

export function generateTypes(ir: OntologyIR, opts: GenerateTypesOpts = {}): string {
    const outputTypeName = opts.outputTypeName ?? "GeneratedOntology";
    const schemaTypes = generateSchemaTypes(toSchemaIR(ir));
    const project = new Project({ useInMemoryFileSystem: true });
    const aggregateFile = project.createSourceFile("ontology-aggregate.ts", "");
    addActionParameterTypes(aggregateFile, ir);
    addOntologyAggregateType(aggregateFile, ir, outputTypeName);
    return `${schemaTypes}\n\n${aggregateFile.getFullText().trim()}`.trim();
}
