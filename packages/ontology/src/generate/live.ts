import { Project } from "ts-morph";
import type { OntologyIR } from "../ir/generated/types.js";

export interface GenerateLiveOpts {
    ontologyImportPath: string;
    ontologyTypesImportPath: string;
    ontologyRuntimeImportPath: string;
    ontologyTypeName: string;
    outputFactoryName: string;
}

export function generateLive(ir: OntologyIR, opts: GenerateLiveOpts): string {
    const ontologyImportName = "ontology";
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("live.ts", "");

    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyRuntimeImportPath,
        namedImports: [{ name: "createLiveOntology" }, { name: "LiveOntology", isTypeOnly: true }],
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyImportPath,
        defaultImport: ontologyImportName,
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyTypesImportPath,
        namedImports: [opts.ontologyTypeName],
        isTypeOnly: true,
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyRuntimeImportPath,
        namedImports: ["CreateLiveOntologyOpts", "OntologyAdapter"],
        isTypeOnly: true,
    });

    sourceFile.addFunction({
        name: opts.outputFactoryName,
        isExported: true,
        typeParameters: [
            {
                name: "Context",
                constraint: "Record<string, unknown>",
                default: "Record<string, unknown>",
            },
        ],
        parameters: [
            { name: "adapter", type: "OntologyAdapter" },
            {
                name: "opts",
                type: "Pick<CreateLiveOntologyOpts<Context>, \"blobStore\" | \"context\" | \"getUserId\" | \"id\">",
                hasQuestionToken: true,
            },
        ],
        returnType: `LiveOntology<${opts.ontologyTypeName}>`,
        statements: `return createLiveOntology<${opts.ontologyTypeName}, Context>({
            ir: ${ontologyImportName},
            adapter,
            id: opts?.id,
            blobStore: opts?.blobStore,
            context: opts?.context,
            getUserId: opts?.getUserId,
        });`,
    });

    return sourceFile.getFullText().trim();
}
