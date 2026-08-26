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
        namedImports: [opts.ontologyTypeName, `${opts.ontologyTypeName}Context`],
        isTypeOnly: true,
    });
    sourceFile.addImportDeclaration({
        moduleSpecifier: opts.ontologyRuntimeImportPath,
        namedImports: ["CreateLiveOntologyOpts"],
        isTypeOnly: true,
    });

    sourceFile.addFunction({
        name: opts.outputFactoryName,
        isExported: true,
        isAsync: true,
        parameters: [
            {
                name: "opts",
                type: `Omit<CreateLiveOntologyOpts<${opts.ontologyTypeName}Context>, "ir">`,
            },
        ],
        returnType: `Promise<LiveOntology<${opts.ontologyTypeName}>>`,
        statements: `return createLiveOntology<${opts.ontologyTypeName}, ${opts.ontologyTypeName}Context>({
            ...opts,
            ir: ${ontologyImportName},
        });`,
    });

    return sourceFile.getFullText().trim();
}
