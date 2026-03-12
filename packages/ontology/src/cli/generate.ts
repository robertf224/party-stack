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
    const ontologyRuntimeImportPath =
        readPackageName(process.cwd()) === "@party-stack/ontology"
            ? "../../runtime.js"
            : "@party-stack/ontology/runtime";

    const ontologyImportPath = toModuleSpecifier(relative(outDir, ontologyPath).replace(/\.ts$/, ".js"));
    const typesOutput = generateTypes(ontology, {
        outputTypeName: generatedOntologyTypeName,
    });
    const liveOutput = generateLive(ontology, {
        ontologyImportPath,
        ontologyTypesImportPath: "./types.js",
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

    await Promise.all([
        formatAndWrite(typesFilePath, typesOutput),
        formatAndWrite(liveFilePath, liveOutput),
    ]);

    console.log(`Generated types written to: ${typesFilePath}`);
    console.log(`Generated live helpers written to: ${liveFilePath}`);
}

const program = new Command();

program
    .name("generate")
    .description("Generate ontology types and live helpers from an OntologyIR file")
    .requiredOption("--ontology <path>", "Path to the ontology module (must export an OntologyIR)")
    .requiredOption("--outDir <path>", "Directory to write generated files")
    .option("--namespace <name>", "Namespace for generated ontology types/factories")
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
