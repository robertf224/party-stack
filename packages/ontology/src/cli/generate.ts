#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pascalCase } from "change-case";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateBuilders } from "../generate/builders.js";
import { generateLive } from "../generate/live.js";
import { generateTypeDefinitions, generateTypes } from "../generate/types.js";
import type { OntologyIR } from "../ir/generated/types.js";

function toModuleSpecifier(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith(".")) {
        return normalized;
    }
    return `./${normalized}`;
}

function ontologyTypeName(namespace: string): string {
    return namespace.endsWith("Ontology") ? namespace : `${namespace}Ontology`;
}

export interface GenerateFilesOpts {
    ontology: string;
    outDir: string;
    namespace?: string;
    jsExtensions?: boolean;
}

function readPackageName(cwd: string): string | null {
    try {
        const packageJson = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf-8")) as {
            name?: string;
        };
        return packageJson.name ?? null;
    } catch {
        return null;
    }
}

function formatImportSpecifier(path: string, jsExtensions: boolean): string {
    const specifier = toModuleSpecifier(path);
    if (jsExtensions) {
        return specifier.replace(/\.[cm]?tsx?$/, ".js");
    }
    return maybeStripJsExtension(specifier, false);
}

function maybeStripJsExtension(specifier: string, jsExtensions: boolean): string {
    if (jsExtensions || !specifier.startsWith(".")) {
        return specifier;
    }
    return specifier.replace(/\.(?:[cm]?jsx?|[cm]?tsx?)$/, "");
}

function resolveValuesImportPath(outDir: string): string {
    const ontologyPackageRoot = fileURLToPath(new URL("../../", import.meta.url));
    if (!resolve(outDir).startsWith(resolve(ontologyPackageRoot))) {
        return "@party-stack/ontology/values";
    }
    const workspaceValuesPath = fileURLToPath(new URL("../../src/utils/values.ts", import.meta.url));
    if (!existsSync(workspaceValuesPath)) {
        return "@party-stack/ontology/values";
    }
    return formatImportSpecifier(relative(outDir, workspaceValuesPath), true);
}

async function formatAndWrite(
    filePath: string,
    content: string,
    prettierConfig: Awaited<ReturnType<typeof resolveConfig>>
): Promise<void> {
    const header = "// Auto-generated file - do not edit manually\n\n";
    const formatted = await format(header + content, {
        ...prettierConfig,
        filepath: filePath,
    });
    writeFileSync(filePath, formatted, "utf-8");
}

function isTypeOnlyOntology(ontology: OntologyIR): boolean {
    return (
        ontology.objectTypes.length === 0 &&
        ontology.linkTypes.length === 0 &&
        ontology.actionTypes.length === 0 &&
        ontology.queryFunctionTypes.length === 0
    );
}

export async function generateFiles(options: GenerateFilesOpts): Promise<void> {
    const ontologyPath = resolve(process.cwd(), options.ontology);
    const outDir = resolve(process.cwd(), options.outDir);
    const jiti = createJiti(import.meta.url);
    const ontologyModule = await jiti.import(ontologyPath);
    const ontology = (ontologyModule as { default: OntologyIR }).default;

    if (!ontology || !Array.isArray(ontology.types) || !Array.isArray(ontology.objectTypes)) {
        throw new Error(`Ontology export from "${options.ontology}" must be an OntologyIR value`);
    }

    mkdirSync(outDir, { recursive: true });
    const prettierConfig = await resolveConfig(outDir);

    if (isTypeOnlyOntology(ontology)) {
        const typesFilePath = join(outDir, "types.ts");
        const buildersFilePath = join(outDir, "builders.ts");
        const typesOutput = generateTypeDefinitions(ontology, {
            valuesImportPath: resolveValuesImportPath(outDir),
        });
        const buildersOutput = generateBuilders(ontology, {
            exportName: "o",
            promoted: "TypeDef",
        });

        await Promise.all([
            formatAndWrite(typesFilePath, typesOutput, prettierConfig),
            formatAndWrite(buildersFilePath, buildersOutput, prettierConfig),
        ]);

        console.log(`Generated types written to: ${typesFilePath}`);
        console.log(`Generated builders written to: ${buildersFilePath}`);
        return;
    }

    const ontologyFileName = basename(ontologyPath, extname(ontologyPath));
    const slug = ontologyFileName === "ontology" ? basename(dirname(ontologyPath)) : ontologyFileName;
    const namespace = options.namespace ?? pascalCase(slug);
    const generatedOntologyTypeName = ontologyTypeName(namespace);
    const jsExtensions = options.jsExtensions ?? true;
    const ontologyRuntimeImportPath = maybeStripJsExtension(
        readPackageName(process.cwd()) === "@party-stack/ontology" ? "../../index.js" : "@party-stack/ontology",
        jsExtensions
    );

    const ontologyImportPath = formatImportSpecifier(relative(outDir, ontologyPath), jsExtensions);
    const typesOutput = generateTypes(ontology, {
        outputTypeName: generatedOntologyTypeName,
    });
    const liveOutput = generateLive(ontology, {
        ontologyImportPath,
        ontologyTypesImportPath: maybeStripJsExtension("./types.js", jsExtensions),
        ontologyRuntimeImportPath,
        ontologyTypeName: generatedOntologyTypeName,
        outputFactoryName: `create${namespace}LiveOntology`,
    });

    const typesFilePath = join(outDir, "types.ts");
    const liveFilePath = join(outDir, "live.ts");

    await Promise.all([
        formatAndWrite(typesFilePath, typesOutput, prettierConfig),
        formatAndWrite(liveFilePath, liveOutput, prettierConfig),
    ]);

    console.log(`Generated types written to: ${typesFilePath}`);
    console.log(`Generated live helpers written to: ${liveFilePath}`);
}
