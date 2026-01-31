import { CodeBlockWriter, Project, Writers, WriterFunction } from "ts-morph";
import { unwrapType } from "../utils/types.js";
import type { SchemaIR, TypeDef, StructTypeDef, UnionTypeDef } from "../ir/ir.js";

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
            return "integer";

        case "float":
            return "float";

        case "double":
            return "double";

        case "date":
            return "date";

        case "timestamp":
            return "timestamp";

        case "geopoint":
            return "geopoint";

        case "list":
            return `Array<${generateForTypeDef(type.value.elementType)}>`;

        case "map":
            return `Record<${generateForTypeDef(type.value.keyType)}, ${generateForTypeDef(type.value.valueType)}>`;

        case "struct":
            return generateForStructTypeDef(type.value);

        case "union":
            return generateForUnionTypeDef(type.value);

        case "optional":
            return union([generateForTypeDef(type.value.type), "undefined"]);

        case "result":
            return `Result<${generateForTypeDef(type.value.okType)}, ${generateForTypeDef(type.value.errType)}>`;

        case "ref":
            return type.value.name;
    }
}

function generateForStructTypeDef(type: StructTypeDef): string {
    return withWriter(
        Writers.objectType({
            properties: type.fields.map((field) => {
                const { type: fieldType, isOptional } = unwrapType(field.type);
                return {
                    name: field.name,
                    type: generateForTypeDef(fieldType),
                    hasQuestionToken: isOptional,
                    docs: field.description ? [{ description: field.description }] : undefined,
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
                    name: variant.name,
                    type: generateForTypeDef(variant.type),
                };
            }),
        })
    );
    return `Union<${innerType}>`;
}

export function generateTypes(schema: SchemaIR): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("types.ts", "");

    // TODO: filter imports
    sourceFile.addImportDeclaration({
        moduleSpecifier: "@party-stack/schema/types",
        namedImports: ["integer", "float", "double", "geopoint", "date", "timestamp", "Union", "Result"],
    });

    for (const type of schema.types) {
        sourceFile.addTypeAlias({
            name: type.name,
            isExported: true,
            type: generateForTypeDef(type.type),
            docs: type.description ? [{ description: type.description }] : undefined,
        });
    }

    return sourceFile.getFullText().trim();
}
