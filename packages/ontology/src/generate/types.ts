import { generateTypes as generateSchemaTypes, type SchemaIR } from "@party-stack/schema";
import { CodeBlockWriter, Project, Writers, type WriterFunction } from "ts-morph";
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

function objectTypeAggregateTypes(ir: OntologyIR): string {
    if (ir.objectTypes.length === 0) {
        return withWriter((writer) => {
            writer.writeLine("export type OntologyObjectTypeName = never;");
            writer.blankLine();
            writer.writeLine("export type OntologyByObjectType = Record<never, never>;");
            writer.blankLine();
            writer.writeLine("export type OntologyObject = never;");
        });
    }

    const objectTypeNames = ir.objectTypes.map((objectType) => objectType.name);
    const byObjectType = withWriter(
        Writers.objectType({
            properties: objectTypeNames.map((name) => ({
                name,
                type: name,
            })),
        })
    );

    return withWriter((writer) => {
        writer.writeLine(
            `export type OntologyObjectTypeName = ${union(objectTypeNames.map((name) => `"${name}"`))};`
        );
        writer.blankLine();
        writer.writeLine(`export type OntologyByObjectType = ${byObjectType};`);
        writer.blankLine();
        writer.writeLine("export type OntologyObject = OntologyByObjectType[OntologyObjectTypeName];");
    });
}

/** Generates OntologyLinkMap-alike type so related() gets typed link names and target row types. */
export function generateLinkMapType(ir: OntologyIR, typeName = "OntologyLinkMap"): string {
    const targetPrimaryKeyByType = new Map(ir.objectTypes.map((ot) => [ot.name, ot.primaryKey]));
    const properties = ir.objectTypes.map((objectType) => {
        const links = ir.linkTypes.filter((linkType) => linkType.source.objectType === objectType.name);
        if (links.length === 0) {
            return {
                name: objectType.name,
                type: "Record<string, never>",
            };
        }

        const linkProperties = links
            .map((linkType) => {
                const targetPrimaryKey = targetPrimaryKeyByType.get(linkType.target.objectType);
                if (!targetPrimaryKey) {
                    return null;
                }

                const linkDefinition = withWriter(
                    Writers.objectType({
                        properties: [
                            {
                                name: "source",
                                type: withWriter(
                                    Writers.objectType({
                                        properties: [
                                            { name: "object", type: linkType.source.objectType },
                                            { name: "name", type: `"${linkType.source.name}"` },
                                        ],
                                    })
                                ),
                            },
                            {
                                name: "target",
                                type: withWriter(
                                    Writers.objectType({
                                        properties: [
                                            { name: "object", type: linkType.target.objectType },
                                            { name: "name", type: `"${linkType.target.name}"` },
                                        ],
                                    })
                                ),
                            },
                            {
                                name: "targetKey",
                                type: `${linkType.target.objectType}["${targetPrimaryKey}"]`,
                            },
                        ],
                    })
                );

                return {
                    // Relationship names on the source side are defined by how source refers to target.
                    name: linkType.target.name,
                    type: linkDefinition,
                };
            })
            .filter((property): property is { name: string; type: string } => property != null);

        return {
            name: objectType.name,
            type:
                linkProperties.length === 0
                    ? "Record<string, never>"
                    : withWriter(Writers.objectType({ properties: linkProperties })),
        };
    });

    const mapType = withWriter(Writers.objectType({ properties }));
    return `export type ${typeName} = ${mapType};`;
}

export interface GenerateTypesOpts {
    /** If set, also emit a link map type for typed related() (e.g. "BlogLinkMap"). */
    linkMapTypeName?: string;
}

export function generateTypes(ir: OntologyIR, opts: GenerateTypesOpts = {}): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("ontology-types.ts", "");

    const schemaTypes = generateSchemaTypes(toSchemaIR(ir));
    const aggregate = objectTypeAggregateTypes(ir);
    const linkMap = opts.linkMapTypeName ? "\n\n" + generateLinkMapType(ir, opts.linkMapTypeName) : "";
    sourceFile.replaceWithText(`${schemaTypes}\n\n${aggregate}${linkMap}`);
    return sourceFile.getFullText().trim();
}
