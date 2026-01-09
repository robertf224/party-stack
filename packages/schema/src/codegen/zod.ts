/**
 * Zod schema generator from Schema IR.
 *
 * Generates Zod validation schemas directly from the IR.
 * Type references are emitted as schema references.
 */

import { Project, SourceFile } from "ts-morph";
import type {
    SchemaIR,
    NamedTypeDef,
    TypeDef,
    VariantDef,
    StructTypeDef,
    UnionTypeDef,
} from "../ir/ir.js";

// ============================================================================
// Zod Schema String Generation
// ============================================================================

function typeDefToZod(type: TypeDef, wrapOptional = true): string {
    let base: string;

    switch (type.kind) {
        case "string":
            if (type.constraint?.kind === "enum") {
                const variants = type.constraint.options.map((o) => `"${o.value}"`).join(", ");
                base = `z.enum([${variants}])`;
            } else {
                base = "z.string()";
            }
            break;

        case "boolean":
            base = "z.boolean()";
            break;

        case "integer":
        case "long":
            base = "z.number().int()";
            break;

        case "float":
        case "double":
            base = "z.number()";
            break;

        case "date":
            base = "z.string().date()";
            break;

        case "timestamp":
            base = "z.string().datetime()";
            break;

        case "geopoint":
            base = "z.object({ lat: z.number(), lon: z.number() })";
            break;

        case "list": {
            const element = typeDefToZod(type.elementType, true);
            base = `z.array(${element})`;
            break;
        }

        case "map": {
            const value = typeDefToZod(type.valueType, true);
            base = `z.record(z.string(), ${value})`;
            break;
        }

        case "struct":
            base = structToZod(type);
            break;

        case "union":
            base = unionToZod(type);
            break;

        case "result": {
            const ok = typeDefToZod(type.okType, false);
            const err = typeDefToZod(type.errType, false);
            base = `z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), value: ${ok} }), z.object({ ok: z.literal(false), error: ${err} })])`;
            break;
        }

        case "ref":
            base = `${type.apiName}Schema`;
            break;
    }

    // Apply optional wrapper if not required
    if (wrapOptional && !type.required) {
        return `${base}.optional()`;
    }
    return base;
}

function structToZod(type: StructTypeDef): string {
    if (type.fields.length === 0) {
        return "z.object({})";
    }

    const fieldStrs = type.fields.map((f) => `${f.apiName}: ${typeDefToZod(f.type, true)}`);
    return `z.object({ ${fieldStrs.join(", ")} })`;
}

function unionToZod(type: UnionTypeDef): string {
    if (type.variants.length === 0) {
        return "z.never()";
    }

    if (type.variants.length === 1) {
        const variant = type.variants[0]!;
        return variantToZod(variant);
    }

    const variantSchemas = type.variants.map((v) => variantToZod(v));
    return `z.discriminatedUnion("type", [${variantSchemas.join(", ")}])`;
}

function variantToZod(variant: VariantDef): string {
    const variantZod = typeDefToZod(variant.type, false);

    if (variant.type.kind === "struct") {
        // Merge the discriminator into the struct
        const fields = variant.type.fields.map((f) => `${f.apiName}: ${typeDefToZod(f.type, true)}`);
        return `z.object({ type: z.literal("${variant.apiName}"), ${fields.join(", ")} })`;
    }

    return `z.object({ type: z.literal("${variant.apiName}") }).merge(${variantZod})`;
}

// ============================================================================
// Public API
// ============================================================================

export interface ZodCodegenOptions {
    /** Whether to generate named exports (default: true) */
    namedExports?: boolean;
    /** Whether to generate inferred TypeScript types (default: true) */
    inferTypes?: boolean;
}

/**
 * Generate Zod schemas for a schema.
 *
 * Each named type becomes a Zod schema variable.
 * References are emitted as schema references.
 */
export function generateZod(schema: SchemaIR, options: ZodCodegenOptions = {}): string {
    const { namedExports = true, inferTypes = true } = options;

    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("generated.ts", "");

    // Add zod import
    sourceFile.addImportDeclaration({
        moduleSpecifier: "zod",
        namedImports: ["z"],
    });

    for (const namedType of schema.types) {
        addZodSchemaForType(sourceFile, namedType, { namedExports, inferTypes });
    }

    return sourceFile.getFullText().trim();
}

function addZodSchemaForType(
    sourceFile: SourceFile,
    namedType: NamedTypeDef,
    options: { namedExports: boolean; inferTypes: boolean }
): void {
    const varName = `${namedType.apiName}Schema`;
    const zodCode = typeDefToZod(namedType.type, false);

    sourceFile.addVariableStatement({
        isExported: options.namedExports,
        declarationKind: "const" as unknown as import("ts-morph").VariableDeclarationKind,
        declarations: [{ name: varName, initializer: zodCode }],
        ...(namedType.description && {
            docs: [{ description: namedType.description }],
        }),
    });

    if (options.inferTypes) {
        sourceFile.addTypeAlias({
            name: namedType.apiName,
            isExported: options.namedExports,
            type: `z.infer<typeof ${varName}>`,
        });
    }
}

/**
 * Generate a ts-morph SourceFile with Zod schemas.
 */
export function generateZodSourceFile(
    project: Project,
    fileName: string,
    schema: SchemaIR,
    options: ZodCodegenOptions = {}
): SourceFile {
    const { namedExports = true, inferTypes = true } = options;

    const sourceFile = project.createSourceFile(fileName, "");

    // Add zod import
    sourceFile.addImportDeclaration({
        moduleSpecifier: "zod",
        namedImports: ["z"],
    });

    for (const namedType of schema.types) {
        addZodSchemaForType(sourceFile, namedType, { namedExports, inferTypes });
    }

    return sourceFile;
}
