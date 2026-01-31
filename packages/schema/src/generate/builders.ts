import { Project, VariableDeclarationKind } from "ts-morph";
import type { NamedTypeDef, SchemaIR, UnionTypeDef } from "../ir/bootstrap-types.js";

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
        builder: `(value: Extract<t.${name}, { kind: "${variant.name}" }>["value"]) => ({ kind: "${variant.name}" as const, value })`,
    }));
}

export function generateBuilders(schema: SchemaIR, opts: GenerateBuildersOpts): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("builders.ts", "");

    const unionTypes = schema.types.filter((type) => type.type.kind === "union") as Array<
        NamedTypeDef & {
            type: { kind: "union"; value: UnionTypeDef };
        }
    >;

    if (unionTypes.length === 0) {
        return "";
    }

    sourceFile.addImportDeclaration({
        moduleSpecifier: "./types.js",
        namespaceImport: "t",
    });

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

    const statements = sourceFile.getVariableStatements();
    for (const statement of statements.slice(0, -1)) {
        statement.appendWhitespace("\n");
    }

    return sourceFile.getFullText().trim();
}
