#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Command } from "commander";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateLive } from "../generate/live.js";
import { generateTypes } from "../generate/types.js";
import type { OntologyIR } from "../ir/generated/types.js";

const program = new Command();

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

program
    .name("generate")
    .description("Generate ontology types and live helpers from an OntologyIR file")
    .requiredOption("--ontology <path>", "Path to the ontology module (must export an OntologyIR)")
    .requiredOption("--outDir <path>", "Directory to write generated files")
    .action(async (options: { ontology: string; outDir: string }) => {
        const ontologyPath = resolve(process.cwd(), options.ontology);
        const outDir = resolve(process.cwd(), options.outDir);
        const jiti = createJiti(import.meta.url);
        const ontologyModule = await jiti.import(ontologyPath);
        const ontology = (ontologyModule as { default: OntologyIR }).default;

        if (!ontology || !Array.isArray(ontology.types) || !Array.isArray(ontology.objectTypes)) {
            console.error(`Error: Ontology export from "${options.ontology}" must be an OntologyIR value`);
            process.exit(1);
        }

        const ontologyFileName = basename(ontologyPath, extname(ontologyPath));
        const slug = ontologyFileName === "ontology" ? basename(dirname(ontologyPath)) : ontologyFileName;
        const namespace = pascalCase(slug);
        const ontologyTypeName = `${namespace}Ontology`;

        const typesFile = "types.ts";
        const liveFile = "live.ts";
        const ontologyImportPath = toModuleSpecifier(relative(outDir, ontologyPath).replace(/\.ts$/, ".js"));

        const typesOutput = generateTypes(ontology, {
            outputTypeName: ontologyTypeName,
        });
        const liveOutput = generateLive(ontology, {
            ontologyImportPath,
            ontologyTypesImportPath: "./types.js",
            ontologyTypeName,
            outputFactoryName: `create${namespace}LiveOntology`,
        });

        mkdirSync(outDir, { recursive: true });

        const typesFilePath = join(outDir, typesFile);
        const liveFilePath = join(outDir, liveFile);
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
    });

program.parse();
