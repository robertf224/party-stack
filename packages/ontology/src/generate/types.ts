import { generateTypes as generateSchemaTypes } from "@party-stack/schema/generate";
import { Project, Writers } from "ts-morph";
import type {
    FieldDef as SchemaFieldDef,
    SchemaIR,
    TypeDef as SchemaTypeDef,
    VariantDef as SchemaVariantDef,
} from "@party-stack/schema";
import type { OntologyIR, ObjectTypeDef, PropertyDef, TypeDef } from "../ir/generated/types.js";

function lowerObjectReferenceType(
    objectTypeName: string,
    objectTypes: ReadonlyMap<string, ObjectTypeDef>
): SchemaTypeDef {
    const objectType = objectTypes.get(objectTypeName)!;
    const primaryKey = objectType.properties.find((property) => property.name === objectType.primaryKey)!;
    return lowerType(primaryKey.type, objectTypes);
}

function lowerType(type: TypeDef, objectTypes: ReadonlyMap<string, ObjectTypeDef>): SchemaTypeDef {
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
            const { objectType } = type.value;
            return lowerObjectReferenceType(objectType, objectTypes);
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
    sourceFile.addTypeAlias({
        name: outputTypeName,
        isExported: true,
        type: Writers.objectType({
            properties: [
                {
                    name: "objectTypes",
                    type:
                        ir.objectTypes.length === 0
                            ? "Record<never, never>"
                            : Writers.objectType({
                                  properties: ir.objectTypes.map((objectType) => ({
                                      name: objectType.name,
                                      type: objectType.name,
                                  })),
                              }),
                },
            ],
        }),
    });
}

export function generateTypes(ir: OntologyIR, opts: GenerateTypesOpts = {}): string {
    const outputTypeName = opts.outputTypeName ?? "GeneratedOntology";
    const project = new Project({ useInMemoryFileSystem: true });
    const schemaTypes = generateSchemaTypes(toSchemaIR(ir));
    const sourceFile = project.createSourceFile("ontology-types.ts", schemaTypes);

    addOntologyAggregateType(sourceFile, ir, outputTypeName);
    return sourceFile.getFullText().trim();
}
