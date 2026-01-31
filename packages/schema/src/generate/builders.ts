import { Project, VariableDeclarationKind } from "ts-morph";
import type { NamedTypeDef, SchemaIR, UnionTypeDef } from "../ir/ir.js";

export interface GenerateBuildersOpts {
    /** The name of the main export (e.g., "p" for `p.string()`). */
    exportName: string;
    /** If set, promotes this union type's variants to the top level of the export. */
    promoted?: string;
}

function unionTypeToBuilders(
    name: string,
    unionType: UnionTypeDef
): Array<{ name: string; builder: string }> {
    return unionType.variants.map((variant) => ({
        name: variant.name,
        builder: `(value: Extract<${name}, { kind: "${variant.name}" }>["value"]) => ({ kind: "${variant.name}" as const, value })`,
    }));
}

/**
 * Generates TypeScript-based builder functions for a schema.
 *
 * The generated builders create discriminated union values from variant payloads.
 */
export function generateBuilders(schema: SchemaIR, opts: GenerateBuildersOpts): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("builders.ts", "");

    const unionTypes = schema.types.filter((type) => type.type.kind === "union") as Array<
        NamedTypeDef & {
            type: { kind: "union"; value: UnionTypeDef };
        }
    >;

    // Add import for union types from the schema file
    if (unionTypes.length > 0) {
        sourceFile.addImportDeclaration({
            moduleSpecifier: "./schema.js",
            namedImports: unionTypes.map((type) => ({ name: type.name, isTypeOnly: true })),
        });
    }

    const promotedType = unionTypes.find((type) => type.name === opts.promoted);
    const promotedBuilders = promotedType ? unionTypeToBuilders(opts.promoted!, promotedType.type.value) : [];

    const nestedTypes = unionTypes.filter((type) => type.name !== opts.promoted);
    const nestedBuilders = nestedTypes.map((type) => ({
        name: type.name,
        builders: unionTypeToBuilders(type.name, type.type.value),
    }));

    for (const builder of promotedBuilders) {
        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [{ name: builder.name, initializer: builder.builder }],
        });
    }

    for (const builders of nestedBuilders) {
        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: builders.name,
                    initializer: `{ ${builders.builders.map((builder) => `${builder.name}: ${builder.builder}`).join(", ")} }`,
                },
            ],
        });
    }

    const exportNames = [
        ...promotedBuilders.map((builder) => builder.name),
        ...nestedBuilders.map((builder) => builder.name),
    ];
    sourceFile.addVariableStatement({
        isExported: true,
        declarationKind: VariableDeclarationKind.Const,
        declarations: [{ name: opts.exportName, initializer: `{ ${exportNames.join(", ")} }` }],
    });

    return sourceFile.getFullText().trim();
}
