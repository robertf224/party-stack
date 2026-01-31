import { Project, VariableDeclarationKind } from "ts-morph";
import type { SchemaIR, TypeDef, StructTypeDef, UnionTypeDef, ResultTypeDef } from "../ir/bootstrap-types.js";

function generateForTypeDef(type: TypeDef): string {
    switch (type.kind) {
        case "string": {
            if (type.value.constraint?.kind === "enum") {
                const variants = type.value.constraint.value.options.map((o) => `"${o.value}"`).join(", ");
                return `z.enum([${variants}])`;
            } else if (type.value.constraint?.kind === "regex") {
                return `z.string().check(z.regex(new RegExp("${type.value.constraint.value.regex}")))`;
            } else {
                return "z.string()";
            }
        }

        case "boolean": {
            return "z.boolean()";
        }

        case "integer": {
            return "z.int32()";
        }

        case "float": {
            return "z.float32()";
        }

        case "double": {
            return "z.float64()";
        }

        case "date": {
            return "z.instanceof(Temporal.PlainDate)";
        }

        case "timestamp": {
            return "z.instanceof(Temporal.Instant)";
        }

        case "geopoint": {
            return "z.object({ lat: z.float64().min(-90).max(90), lon: z.float64().min(-180).max(180) })";
        }

        case "list": {
            const elementType = generateForTypeDef(type.value.elementType);
            return `z.array(${elementType})`;
        }

        case "map": {
            const keyType = generateForTypeDef(type.value.keyType);
            const valueType = generateForTypeDef(type.value.valueType);
            return `z.record(${keyType}, ${valueType})`;
        }

        case "struct": {
            return generateForStructTypeDef(type.value);
        }

        case "union": {
            return generateForUnionTypeDef(type.value);
        }

        case "optional": {
            const valueType = generateForTypeDef(type.value.type);
            return `z.optional(${valueType})`;
        }

        case "result": {
            return generateForResultTypeDef(type.value);
        }

        case "ref": {
            return `z.lazy(() => ${type.value.name})`;
        }
    }
}

function generateForStructTypeDef(type: StructTypeDef): string {
    const fieldSchemas = type.fields.map((f) => `${f.name}: ${generateForTypeDef(f.type)}`);
    return `z.object({ ${fieldSchemas.join(", ")} })`;
}

function generateForUnionTypeDef(type: UnionTypeDef): string {
    const variantSchemas = type.variants.map(
        (v) => `z.object({ kind: z.literal("${v.name}"), value: ${generateForTypeDef(v.type)} })`
    );
    return `z.discriminatedUnion("kind", [${variantSchemas.join(", ")}])`;
}

function generateForResultTypeDef(type: ResultTypeDef): string {
    const okSchema = `z.object({ kind: z.literal("ok"), value: ${generateForTypeDef(type.okType)} })`;
    const errSchema = `z.object({ kind: z.literal("err"), value: ${generateForTypeDef(type.errType)} })`;
    return `z.discriminatedUnion("kind", [${okSchema}, ${errSchema}])`;
}

export function generateValidators(schema: SchemaIR): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("validators.ts", "");

    sourceFile.addImportDeclaration({
        moduleSpecifier: "zod/mini",
        namedImports: ["z"],
    });

    sourceFile.addImportDeclaration({
        moduleSpecifier: "./types.js",
        namespaceImport: "t",
    });

    for (const type of schema.types) {
        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: type.name,
                    type: `z.ZodMiniType<t.${type.name}>`,
                    initializer: generateForTypeDef(type.type),
                },
            ],
        });
    }

    const statements = sourceFile.getVariableStatements();
    for (const statement of statements.slice(0, -1)) {
        statement.appendWhitespace("\n");
    }

    return sourceFile.getFullText().trim();
}
