import { generateTypes as generateSchemaTypes } from "@party-stack/schema/generate";
import { Project, Writers, type SourceFile } from "ts-morph";
import type { SchemaIR } from "@party-stack/schema";
import type { OntologyIR } from "../ir/generated/types.js";

function toSchemaIR(ir: OntologyIR): SchemaIR {
    return {
        types: [
            ...ir.types.map((type) => ({
                name: type.name,
                description: type.description,
                deprecated: type.deprecated,
                type: type.type,
            })),
            ...ir.objectTypes.map((objectType) => ({
                name: objectType.name,
                description: objectType.description,
                deprecated: objectType.deprecated,
                type: {
                    kind: "struct" as const,
                    value: {
                        fields: objectType.properties.map((property) => ({
                            name: property.name,
                            displayName: property.displayName,
                            description: property.description,
                            deprecated: property.deprecated,
                            type: property.type,
                        })),
                    },
                },
            })),
        ],
    };
}

export interface GenerateTypesOpts {
    outputTypeName?: string;
}

function addOntologyAggregateType(sourceFile: SourceFile, ir: OntologyIR, outputTypeName: string): void {
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
