import { CodeBlockWriter, Project, Writers, WriterFunction } from "ts-morph";
import { unwrapType } from "../utils/types.js";
import { buildJsDocs } from "./utils/buildJsDocs.js";
import type { SchemaIR, TypeDef, StructTypeDef, UnionTypeDef } from "../ir/index.js";

export interface GenerateTypesOpts {
    valuesImportPath?: string;
}

function renderPropertyName(name: string): string {
    return /^[$A-Z_][0-9A-Z_$]*$/i.test(name) ? name : JSON.stringify(name);
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
        return options[1]!;
    }
    return withWriter(Writers.unionType(options[0]!, options[1]!, ...options.slice(2)));
}

function generateForTypeDef(type: TypeDef): string {
    switch (type.kind) {
        case "string": {
            if (type.value.constraint?.kind === "enum") {
                const options = type.value.constraint.value.options;
                return union(options.map((option) => `"${option.value}"`));
            }
            return "string";
        }

        case "boolean":
            return "boolean";

        case "integer":
            return "v.integer";

        case "float":
            return "v.float";

        case "double":
            return "v.double";

        case "date":
            return "v.date";

        case "timestamp":
            return "v.timestamp";

        case "geopoint":
            return "v.geopoint";

        case "attachment":
            return "v.attachment";

        case "unknown":
            return "unknown";

        case "list":
            return `Array<${generateForTypeDef(type.value.elementType)}>`;

        case "map":
            return `Map<${generateForTypeDef(type.value.keyType)}, ${generateForTypeDef(type.value.valueType)}>`;

        case "struct":
            return generateForStructTypeDef(type.value);

        case "union":
            return generateForUnionTypeDef(type.value);

        case "optional":
            return union([generateForTypeDef(type.value.type), "undefined"]);

        case "result":
            return `v.Result<${generateForTypeDef(type.value.okType)}, ${generateForTypeDef(type.value.errType)}>`;

        case "ref":
            return type.value.name;
    }
}

function generateForStructTypeDef(type: StructTypeDef): string {
    if (type.fields.length === 0) {
        return "Record<never, never>";
    }

    return withWriter(
        Writers.objectType({
            properties: type.fields.map((field) => {
                const { type: fieldType, isOptional } = unwrapType(field.type);
                return {
                    name: renderPropertyName(field.name),
                    type: generateForTypeDef(fieldType),
                    hasQuestionToken: isOptional,
                    docs: buildJsDocs({ description: field.description, deprecated: field.deprecated }),
                };
            }),
        })
    );
}

function generateForUnionTypeDef(type: UnionTypeDef): string {
    const innerType = withWriter(
        Writers.objectType({
            properties: type.variants.map((variant) => {
                return {
                    name: renderPropertyName(variant.name),
                    type: generateForTypeDef(variant.type),
                };
            }),
        })
    );
    return `v.Union<${innerType}>`;
}

export function generateTypes(schema: SchemaIR, opts: GenerateTypesOpts = {}): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("types.ts", "");

    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.valuesImportPath ?? "@party-stack/schema/values",
        namespaceImport: "v",
    });

    for (const type of schema.types) {
        sourceFile.addTypeAlias({
            name: type.name,
            isExported: true,
            type: generateForTypeDef(type.type),
            docs: buildJsDocs({ description: type.description, deprecated: type.deprecated }),
        });
    }

    const typeAliases = sourceFile.getTypeAliases();
    for (const alias of typeAliases.slice(0, -1)) {
        alias.appendWhitespace("\n");
    }

    return sourceFile.getFullText().trim();
}
