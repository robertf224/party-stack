#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateLive } from "../generate/live.js";
import { generateTypes } from "../generate/types.js";
import type { OntologyIR } from "../ir/generated/types.js";

function toModuleSpecifier(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith(".")) {
        return normalized;
    }
    return `./${normalized}`;
}

function pascalCase(value: string): string {
    return value
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
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

export async function generateFiles(options: GenerateFilesOpts): Promise<void> {
    const ontologyPath = resolve(process.cwd(), options.ontology);
    const outDir = resolve(process.cwd(), options.outDir);
    const jiti = createJiti(import.meta.url);
    const ontologyModule = await jiti.import(ontologyPath);
    const ontology = (ontologyModule as { default: OntologyIR }).default;

    if (!ontology || !Array.isArray(ontology.types) || !Array.isArray(ontology.objectTypes)) {
        throw new Error(`Ontology export from "${options.ontology}" must be an OntologyIR value`);
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

    mkdirSync(outDir, { recursive: true });

    const typesFilePath = join(outDir, "types.ts");
    const liveFilePath = join(outDir, "live.ts");
    const header = "// Auto-generated file - do not edit manually\n\n";
    const prettierConfig = await resolveConfig(outDir);

    const formatAndWrite = async (filePath: string, content: string) => {
        const formatted = await format(header + content, {
            ...prettierConfig,
            filepath: filePath,
        });
        writeFileSync(filePath, formatted, "utf-8");
    };

    await Promise.all([formatAndWrite(typesFilePath, typesOutput), formatAndWrite(liveFilePath, liveOutput)]);

    console.log(`Generated types written to: ${typesFilePath}`);
    console.log(`Generated live helpers written to: ${liveFilePath}`);
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

const program = new Command();

program
    .name("generate")
    .description("Generate ontology types and live helpers from an OntologyIR file")
    .requiredOption("--ontology <path>", "Path to the ontology module (must export an OntologyIR)")
    .requiredOption("--outDir <path>", "Directory to write generated files")
    .option("--namespace <name>", "Namespace for generated ontology types/factories")
    .option("--no-js-extensions", "Omit .js extensions from generated relative imports")
    .action(async (options: GenerateFilesOpts) => {
        try {
            await generateFiles(options);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    program.parse();
}
