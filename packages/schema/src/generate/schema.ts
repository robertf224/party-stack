import { Project, VariableDeclarationKind } from "ts-morph";
import type { SchemaIR, TypeDef, StructTypeDef, UnionTypeDef, ResultTypeDef } from "../ir/ir.js";

function typeDefToZod(type: TypeDef): string {
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
            const elementType = typeDefToZod(type.value.elementType);
            return `z.array(${elementType})`;
        }

        case "map": {
            const keyType = typeDefToZod(type.value.keyType);
            const valueType = typeDefToZod(type.value.valueType);
            return `z.record(${keyType}, ${valueType})`;
        }

        case "struct": {
            return structTypeDefToZod(type.value);
        }

        case "union": {
            return unionTypeDefToZod(type.value);
        }

        case "optional": {
            const valueType = typeDefToZod(type.value.type);
            return `z.optional(${valueType})`;
        }

        case "result": {
            return resultTypeDefToZod(type.value);
        }

        case "ref": {
            return type.value.name;
        }
    }
}

function structTypeDefToZod(type: StructTypeDef): string {
    const fieldSchemas = type.fields.map((f) => `get ${f.name}() { return ${typeDefToZod(f.type)}; }`);
    return `z.object({ ${fieldSchemas.join(", ")} })`;
}

function unionTypeDefToZod(type: UnionTypeDef): string {
    const variantSchemas = type.variants.map(
        (v) => `z.object({ kind: z.literal("${v.name}"), value: ${typeDefToZod(v.type)} })`
    );
    return `z.discriminatedUnion("kind", [${variantSchemas.join(", ")}])`;
}

function resultTypeDefToZod(type: ResultTypeDef): string {
    const okSchema = `z.object({ kind: z.literal("ok"), value: ${typeDefToZod(type.okType)} })`;
    const errSchema = `z.object({ kind: z.literal("err"), value: ${typeDefToZod(type.errType)} })`;
    return `z.discriminatedUnion("kind", [${okSchema}, ${errSchema}])`;
}

export function generateSchema(schema: SchemaIR): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", "");

    sourceFile.addImportDeclaration({
        moduleSpecifier: "zod/mini",
        namedImports: ["z"],
    });

    for (const namedType of schema.types) {
        const variableName = namedType.name;
        const zodCode = typeDefToZod(namedType.type);

        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [{ name: variableName, initializer: zodCode }],
            ...(namedType.description && {
                docs: [{ description: namedType.description }],
            }),
        });

        sourceFile.addTypeAlias({
            name: namedType.name,
            isExported: true,
            type: `z.infer<typeof ${variableName}>`,
        });
    }

    return sourceFile.getFullText().trim();
}
