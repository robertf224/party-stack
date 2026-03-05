import { generateTypes as generateSchemaTypes, type SchemaIR } from "@party-stack/schema";
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

function objectTypeAggregateTypes(ir: OntologyIR): string {
    if (ir.objectTypes.length === 0) {
        return [
            "export type OntologyObjectTypeName = never;",
            "export type OntologyByObjectType = Record<never, never>;",
            "export type OntologyObject = never;",
        ].join("\n");
    }

    const names = ir.objectTypes.map((objectType) => objectType.name);
    return [
        `export type OntologyObjectTypeName = ${names.map((name) => `"${name}"`).join(" | ")};`,
        "export type OntologyByObjectType = {",
        ...names.map((name) => `    ${name}: ${name};`),
        "};",
        "export type OntologyObject = OntologyByObjectType[OntologyObjectTypeName];",
    ].join("\n");
}

/** Generates OntologyLinkMap-alike type so related() gets typed link names and target row types. */
export function generateLinkMapType(ir: OntologyIR, typeName = "OntologyLinkMap"): string {
    /* eslint-disable @typescript-eslint/no-unsafe-member-access */
    const targetPrimaryKeyByType = new Map(ir.objectTypes.map((ot) => [ot.name, ot.primaryKey]));
    const lines: string[] = [`export type ${typeName} = {`];
    for (const ot of ir.objectTypes) {
        const links = ir.linkTypes.filter((lt) => lt.source.objectType === ot.name);
        if (links.length === 0) {
            lines.push(`    ${ot.name}: Record<string, never>;`);
        } else {
            const linkEntries = links
                .map((lt) => {
                    const targetPk = targetPrimaryKeyByType.get(lt.target.objectType);
                    if (!targetPk) return null;
                    return `        ${lt.source.name}: { target: ${lt.target.objectType}; targetKey: ${lt.target.objectType}["${targetPk}"] };`;
                })
                .filter((line): line is string => line != null);
            lines.push(`    ${ot.name}: {`);
            lines.push(...linkEntries);
            lines.push("    };");
        }
    }
    lines.push("};");
    return lines.join("\n");
}

export interface GenerateTypesOpts {
    /** If set, also emit a link map type for typed related() (e.g. "BlogLinkMap"). */
    linkMapTypeName?: string;
}

export function generateTypes(ir: OntologyIR, opts: GenerateTypesOpts = {}): string {
    const schemaTypes = generateSchemaTypes(toSchemaIR(ir));
    const aggregate = objectTypeAggregateTypes(ir);
    const linkMap = opts.linkMapTypeName ? "\n\n" + generateLinkMapType(ir, opts.linkMapTypeName) : "";
    return `${schemaTypes}\n\n${aggregate}${linkMap}`;
}
