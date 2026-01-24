import { Project, VariableDeclarationKind } from "ts-morph";
import type { SchemaIR, TypeDef, StructTypeDef, UnionTypeDef, ResultTypeDef } from "../ir/ir.js";

function typeDefToZod(type: TypeDef): string {
    let output: string;

    switch (type.kind) {
        case "string": {
            if (type.constraint?.kind === "enum") {
                const variants = type.constraint.options.map((o) => `"${o.value}"`).join(", ");
                output = `z.enum([${variants}])`;
            } else {
                output = "z.string()";
            }
            break;
        }

        case "boolean": {
            output = "z.boolean()";
            break;
        }

        case "integer": {
            output = "z.int32()";
            break;
        }

        case "float": {
            output = "z.float32()";
            break;
        }

        case "double": {
            output = "z.float64()";
            break;
        }

        case "date": {
            output = "z.instanceof(Temporal.PlainDate)";
            break;
        }

        case "timestamp": {
            output = "z.instanceof(Temporal.Instant)";
            break;
        }

        case "geopoint": {
            output = "z.object({ lat: z.float64().min(-90).max(90), lon: z.float64().min(-180).max(180) })";
            break;
        }

        case "list": {
            const elementType = typeDefToZod(type.elementType);
            output = `z.array(${elementType})`;
            break;
        }

        case "map": {
            const keyType = typeDefToZod(type.valueType);
            const valueType = typeDefToZod(type.valueType);
            output = `z.record(${keyType}, ${valueType})`;
            break;
        }

        case "struct": {
            output = structTypeDefToZod(type);
            break;
        }

        case "union": {
            output = unionTypeDefToZod(type);
            break;
        }

        case "result": {
            return resultTypeDefToZod(type);
        }

        case "ref": {
            output = type.apiName;
            break;
        }
    }

    if (!type.required) {
        output = `${output}.optional()`;
    }

    return output;
}

function structTypeDefToZod(type: StructTypeDef): string {
    const fieldSchemas = type.fields.map((f) => `${f.apiName}: ${typeDefToZod(f.type)}`);
    return `z.object({ ${fieldSchemas.join(", ")} })`;
}

function unionTypeDefToZod(type: UnionTypeDef): string {
    const variantSchemas = type.variants.map(
        (v) => `z.object({ kind: z.literal("${v.apiName}"), value: ${typeDefToZod(v.type)} })`
    );
    return `z.discriminatedUnion("kind", [${variantSchemas.join(", ")}])`;
}

function resultTypeDefToZod(type: ResultTypeDef): string {
    const okSchema = `z.object({ kind: z.literal("ok"), value: ${typeDefToZod(type.okType)} })`;
    const errSchema = `z.object({ kind: z.literal("err"), value: ${typeDefToZod(type.errType)} })`;
    return `z.discriminatedUnion("kind", [${okSchema}, ${errSchema}])`;
}

export function generateZod(schema: SchemaIR): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("schema.ts", "");

    sourceFile.addImportDeclaration({
        // TODO: maybe use mini?
        moduleSpecifier: "zod/v4",
        namedImports: ["z"],
    });

    for (const namedType of schema.types) {
        const variableName = namedType.apiName;
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
            name: namedType.apiName,
            isExported: true,
            type: `z.infer<typeof ${variableName}>`,
        });
    }

    return sourceFile.getFullText().trim();
}
