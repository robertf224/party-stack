#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pascalCase } from "change-case";
import { createJiti } from "jiti";
import { generateBuilders } from "../generate/builders.js";
import { generateConstants } from "../generate/constants.js";
import { generateLive } from "../generate/live.js";
import { generateEffectSchemas } from "../generate/schemas.js";
import { generateTypeDefinitions, generateTypes } from "../generate/types.js";
import { formatGeneratedFile } from "./format.js";
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
    emitLive?: boolean;
    emitEffectSchemas?: boolean;
    valuesImportPath?: string;
    runtimeImportPath?: string;
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
        return "@party-stack/ontology-spec/values";
    }
    const workspaceValuesPath = fileURLToPath(new URL("../../src/utils/values.ts", import.meta.url));
    if (!existsSync(workspaceValuesPath)) {
        return "@party-stack/ontology-spec/values";
    }
    return formatImportSpecifier(relative(outDir, workspaceValuesPath), true);
}

async function formatAndWrite(filePath: string, content: string): Promise<void> {
    const formatted = await formatGeneratedFile(filePath, content);
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

async function writeEffectFiles(
    ontology: OntologyIR,
    outDir: string,
    options: GenerateFilesOpts,
    outputTypeName?: string
) {
    if (!options.emitEffectSchemas) return;
    const schemasPath = join(outDir, "effect.ts");
    const effectTypesPath = join(outDir, "effect-types.ts");
    const valuesImportPath = "@party-stack/ontology-spec/effect/values";
    const types = outputTypeName
        ? generateTypes(ontology, { outputTypeName, valuesImportPath })
        : generateTypeDefinitions(ontology, { valuesImportPath });
    await formatAndWrite(effectTypesPath, types);
    await formatAndWrite(
        schemasPath,
        generateEffectSchemas(ontology, {
            typesImportPath: maybeStripJsExtension("./effect-types.js", options.jsExtensions ?? true),
            encodedTypesImportPath: maybeStripJsExtension("./types.js", options.jsExtensions ?? true),
        })
    );
    console.log(`Generated Effect models written to: ${effectTypesPath}`);
    console.log(`Generated Effect schemas written to: ${schemasPath}`);
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

    if (isTypeOnlyOntology(ontology)) {
        const typesFilePath = join(outDir, "types.ts");
        const buildersFilePath = join(outDir, "builders.ts");
        const constantsFilePath = join(outDir, "constants.ts");
        const typesOutput = generateTypeDefinitions(ontology, {
            valuesImportPath: options.valuesImportPath ?? resolveValuesImportPath(outDir),
        });
        const buildersOutput = generateBuilders(ontology, {
            exportName: "o",
            promoted: "TypeDef",
        });
        const constantsOutput = generateConstants(ontology);

        await Promise.all([
            formatAndWrite(typesFilePath, typesOutput),
            formatAndWrite(buildersFilePath, buildersOutput),
            formatAndWrite(constantsFilePath, constantsOutput),
        ]);

        await writeEffectFiles(ontology, outDir, options);
        console.log(`Generated types written to: ${typesFilePath}`);
        console.log(`Generated builders written to: ${buildersFilePath}`);
        console.log(`Generated constants written to: ${constantsFilePath}`);
        return;
    }

    const ontologyFileName = basename(ontologyPath, extname(ontologyPath));
    const slug = ontologyFileName === "ontology" ? basename(dirname(ontologyPath)) : ontologyFileName;
    const namespace = options.namespace ?? pascalCase(slug);
    const generatedOntologyTypeName = ontologyTypeName(namespace);
    const jsExtensions = options.jsExtensions ?? true;
    const ontologyRuntimeImportPath = maybeStripJsExtension(
        options.runtimeImportPath ??
            (readPackageName(process.cwd()) === "@party-stack/ontology"
                ? "../../index.js"
                : "@party-stack/ontology"),
        jsExtensions
    );

    const ontologyImportPath = formatImportSpecifier(relative(outDir, ontologyPath), jsExtensions);
    const typesOutput = generateTypes(ontology, {
        outputTypeName: generatedOntologyTypeName,
        valuesImportPath: options.valuesImportPath ?? resolveValuesImportPath(outDir),
    });
    const constantsOutput = generateConstants(ontology);
    const liveOutput = generateLive(ontology, {
        ontologyImportPath,
        ontologyTypesImportPath: maybeStripJsExtension("./types.js", jsExtensions),
        ontologyRuntimeImportPath,
        ontologyTypeName: generatedOntologyTypeName,
        outputFactoryName: `create${namespace}LiveOntology`,
    });

    const typesFilePath = join(outDir, "types.ts");
    const liveFilePath = join(outDir, "live.ts");
    const constantsFilePath = join(outDir, "constants.ts");

    await Promise.all([
        formatAndWrite(typesFilePath, typesOutput),
        ...(options.emitLive === false ? [] : [formatAndWrite(liveFilePath, liveOutput)]),
        formatAndWrite(constantsFilePath, constantsOutput),
    ]);

    await writeEffectFiles(ontology, outDir, options, generatedOntologyTypeName);
    console.log(`Generated types written to: ${typesFilePath}`);
    if (options.emitLive !== false) console.log(`Generated live helpers written to: ${liveFilePath}`);
    console.log(`Generated constants written to: ${constantsFilePath}`);
}
