/**
 * TypeScript code generator from Schema IR.
 *
 * Generates TypeScript type definitions directly from the IR.
 * Type references are emitted as type names (TypeScript handles the linking).
 */

import { Project, SourceFile } from "ts-morph";
import type { SchemaIR, NamedTypeDef, TypeDef, FieldDef, StructTypeDef, UnionTypeDef } from "../ir/ir.js";

// ============================================================================
// Type String Generation
// ============================================================================

function typeDefToTypeString(type: TypeDef): string {
    switch (type.kind) {
        case "string":
            if (type.constraint?.kind === "enum") {
                return type.constraint.options.map((o) => `"${o.value}"`).join(" | ");
            }
            return "string";

        case "boolean":
            return "boolean";

        case "integer":
        case "long":
        case "float":
        case "double":
            return "number";

        case "date":
        case "timestamp":
            return "string"; // ISO date strings

        case "geopoint":
            return "{ lat: number; lon: number }";

        case "list": {
            const element = typeDefToTypeString(type.elementType);
            // Wrap in parentheses if it contains a union
            return element.includes("|") ? `(${element})[]` : `${element}[]`;
        }

        case "map": {
            const value = typeDefToTypeString(type.valueType);
            return `Record<string, ${value}>`;
        }

        case "struct":
            return structToInlineTypeString(type);

        case "union":
            return unionToInlineTypeString(type);

        case "result": {
            const ok = typeDefToTypeString(type.okType);
            const err = typeDefToTypeString(type.errType);
            return `{ readonly ok: true; readonly value: ${ok} } | { readonly ok: false; readonly error: ${err} }`;
        }

        case "ref":
            return type.apiName;
    }
}

function fieldToTypeString(field: FieldDef): string {
    const typeStr = typeDefToTypeString(field.type);
    const optional = !field.type.required ? "?" : "";
    return `readonly ${field.apiName}${optional}: ${typeStr};`;
}

function structToInlineTypeString(type: StructTypeDef): string {
    if (type.fields.length === 0) {
        return "{}";
    }
    const fieldStrs = type.fields.map((f) => fieldToTypeString(f));
    return `{ ${fieldStrs.join(" ")} }`;
}

function unionToInlineTypeString(type: UnionTypeDef): string {
    if (type.variants.length === 0) {
        return "never";
    }

    const variantTypes = type.variants.map((variant) => {
        const variantTypeStr = typeDefToTypeString(variant.type);
        // If the variant is a struct, merge the tag field into it
        if (variant.type.kind === "struct") {
            const fields = variant.type.fields.map((f) => fieldToTypeString(f)).join(" ");
            return `{ readonly type: "${variant.apiName}"; ${fields} }`;
        }
        return `{ readonly type: "${variant.apiName}" } & ${variantTypeStr}`;
    });

    return variantTypes.join(" | ");
}

function namedTypeToTypeString(namedType: NamedTypeDef): string {
    return typeDefToTypeString(namedType.type);
}

// ============================================================================
// Public API
// ============================================================================

export interface TypeScriptCodegenOptions {
    /** Whether to export the types (default: true) */
    export?: boolean;
}

/**
 * Generate TypeScript types for a schema.
 *
 * Each named type becomes a TypeScript type alias.
 * References are emitted as type names.
 */
export function generateTypeScript(schema: SchemaIR, options: TypeScriptCodegenOptions = {}): string {
    const { export: exportTypes = true } = options;

    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("generated.ts", "");

    for (const namedType of schema.types) {
        const typeString = namedTypeToTypeString(namedType);

        sourceFile.addTypeAlias({
            name: namedType.apiName,
            isExported: exportTypes,
            type: typeString,
            ...(namedType.description && {
                docs: [{ description: namedType.description }],
            }),
        });
    }

    return sourceFile.getFullText().trim();
}

/**
 * Generate a ts-morph SourceFile with types.
 */
export function generateTypeScriptSourceFile(
    project: Project,
    fileName: string,
    schema: SchemaIR,
    options: TypeScriptCodegenOptions = {}
): SourceFile {
    const { export: exportTypes = true } = options;

    const sourceFile = project.createSourceFile(fileName, "");

    for (const namedType of schema.types) {
        const typeString = namedTypeToTypeString(namedType);

        sourceFile.addTypeAlias({
            name: namedType.apiName,
            isExported: exportTypes,
            type: typeString,
            ...(namedType.description && {
                docs: [{ description: namedType.description }],
            }),
        });
    }

    return sourceFile;
}
