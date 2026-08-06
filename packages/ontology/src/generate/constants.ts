import { Project, VariableDeclarationKind } from "ts-morph";
import type { OntologyIR } from "../ir/generated/types.js";

function isNamedStringEnum(
    type: OntologyIR["types"][number]
): type is OntologyIR["types"][number] & {
    type: {
        kind: "string";
        value: {
            constraint: {
                kind: "enum";
                value: {
                    options: Array<{ value: string; label?: string }>;
                };
            };
        };
    };
} {
    return type.type.kind === "string" && type.type.value.constraint?.kind === "enum";
}

export function generateConstants(schema: Pick<OntologyIR, "types">): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("constants.ts", "");
    const enumTypes = schema.types.filter(isNamedStringEnum);

    for (const type of enumTypes) {
        const optionsName = `${type.name}Options`;
        sourceFile.addVariableStatement({
            isExported: true,
            declarationKind: VariableDeclarationKind.Const,
            declarations: [
                {
                    name: optionsName,
                    initializer: `${JSON.stringify(type.type.value.constraint.value.options)} as const`,
                },
            ],
        });
    }

    if (enumTypes.length === 0) {
        sourceFile.addExportDeclaration({});
    }

    const declarations = sourceFile.getVariableStatements();
    for (const declaration of declarations.slice(0, -1)) {
        declaration.appendWhitespace("\n");
    }

    return sourceFile.getFullText().trim();
}
