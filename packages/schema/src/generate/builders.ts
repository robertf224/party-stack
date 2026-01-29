import { Project, VariableDeclarationKind } from "ts-morph";
import type { NamedTypeDef, SchemaIR, UnionTypeDef } from "../ir/ir.js";

export interface GenerateBuildersOpts {
    /** The name of the main export (e.g., "p" for `p.string()`). */
    exportName: string;
    /** If set, promotes this union type's variants to the top level of the export. */
    promoted?: string;
}

function unionTypeToBuilders(
    apiName: string,
    unionType: UnionTypeDef
): Array<{ apiName: string; builder: string }> {
    return unionType.variants.map((variant) => ({
        apiName: variant.apiName,
        builder: `(value: Extract<${apiName}, { kind: ${variant.apiName} }>["value"]) => ({ kind: "${variant.apiName}" as const, value })`,
    }));
}

/**
 * Generates TypeScript-based builder functions for a schema.
 *
 * The generated builders create discriminated union values from variant payloads.
 */
export function generateBuilders(schema: SchemaIR, opts: GenerateBuildersOpts): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("idl.ts", "");

    const unionTypes = schema.types.filter((type) => type.type.kind === "union") as Array<
        NamedTypeDef & {
            type: UnionTypeDef;
        }
    >;

    const promotedType = unionTypes.find((type) => type.apiName === opts.promoted);
    const promotedBuilders = promotedType ? unionTypeToBuilders(opts.promoted!, promotedType.type) : [];

    const nestedTypes = unionTypes.filter((type) => type.apiName !== opts.promoted);
    const nestedBuilders = nestedTypes.map((type) => ({
        apiName: type.apiName,
        builders: unionTypeToBuilders(type.apiName, type.type),
    }));

    for (const builder of promotedBuilders) {
        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [{ name: builder.apiName, initializer: builder.builder }],
        });
    }

    for (const builders of nestedBuilders) {
        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: builders.apiName,
                    initializer: `{ ${builders.builders.map((builder) => `${builder.apiName}: ${builder.builder}`).join(", ")} }`,
                },
            ],
        });
    }

    const exportNames = [
        ...promotedBuilders.map((builder) => builder.apiName),
        ...nestedBuilders.map((builder) => builder.apiName),
    ];
    sourceFile.addVariableStatement({
        isExported: true,
        declarationKind: VariableDeclarationKind.Const,
        declarations: [{ name: opts.exportName, initializer: `{ ${exportNames.join(", ")} }` }],
    });

    return sourceFile.getFullText().trim();
}
