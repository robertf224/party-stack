import { Project, VariableDeclarationKind } from "ts-morph";
import type { OntologyIR } from "../ir/generated/types.js";

export interface GenerateLiveOpts {
    ontologyImportPath: string;
    ontologyExportName: string;
    ontologyTypesImportPath: string;
    ontologyByObjectTypeTypeName?: string;
    /** If set, use this link map type for typed related() (e.g. "BlogLinkMap"). Must match linkMapTypeName used in generateTypes. */
    linkMapTypeName?: string;
    liveOntologyImportPath?: string;
    ontologyAdapterImportPath?: string;
    outputTypeName: string;
    outputFactoryName: string;
}

export function generateLive(ir: OntologyIR, opts: GenerateLiveOpts): string {
    const byObjectTypeTypeName = opts.ontologyByObjectTypeTypeName ?? "OntologyByObjectType";
    const linkMapTypeName = opts.linkMapTypeName;
    const liveOntologyImportPath = opts.liveOntologyImportPath ?? "../../LiveOntology.js";
    const ontologyAdapterImportPath = opts.ontologyAdapterImportPath ?? "../../OntologyAdapter.js";

    const linkMapGeneric = linkMapTypeName ? `, ${linkMapTypeName}` : "";
    const typeParams = `${byObjectTypeTypeName}${linkMapGeneric}`;
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("live.ts", "");

    sourceFile.addImportDeclaration({
        moduleSpecifier: liveOntologyImportPath,
        namedImports: [{ name: "createLiveOntology" }, { name: "LiveOntology", isTypeOnly: true }],
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyImportPath,
        namedImports: [opts.ontologyExportName],
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyTypesImportPath,
        namedImports: [byObjectTypeTypeName, ...(linkMapTypeName ? [linkMapTypeName] : [])],
        isTypeOnly: true,
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: ontologyAdapterImportPath,
        namedImports: ["OntologyAdapter"],
        isTypeOnly: true,
    });

    sourceFile.addVariableStatement({
        declarationKind: VariableDeclarationKind.Const,
        isExported: true,
        declarations: [
            {
                name: "objectTypeNames",
                initializer:
                    ir.objectTypes.length === 0
                        ? "[] as const"
                        : `[${ir.objectTypes.map((type) => `"${type.name}"`).join(", ")}] as const`,
            },
        ],
    });

    sourceFile.addTypeAlias({
        name: opts.outputTypeName,
        isExported: true,
        type: `LiveOntology<${typeParams}>`,
    });

    sourceFile.addFunction({
        name: opts.outputFactoryName,
        isExported: true,
        parameters: [{ name: "adapter", type: "OntologyAdapter" }],
        returnType: opts.outputTypeName,
        statements: `return createLiveOntology<${typeParams}>({
            ir: ${opts.ontologyExportName},
            adapter,
        });`,
    });

    return sourceFile.getFullText().trim();
}
