#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { generateFiles } from "./generate.js";
import {
    ONTOLOGY_CONFIG_PATH,
    ONTOLOGY_IR_PATH,
    discoverOntologyConfigPath,
    loadOntologyConfig,
    writePulledOntology,
} from "./pull.js";

const GENERATED_DIR_PATH = "src/ontology/generated";

function pascalCase(value: string): string {
    return value
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join("");
}

function readPackageNamespace(cwd: string): string {
    const packageJsonPath = resolve(cwd, "package.json");
    if (!existsSync(packageJsonPath)) {
        return pascalCase(basename(cwd));
    }

    try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
        const packageName =
            typeof packageJson.name === "string"
                ? packageJson.name.split("/").pop() ?? packageJson.name
                : basename(cwd);
        return pascalCase(packageName);
    } catch {
        return pascalCase(basename(cwd));
    }
}

async function main(): Promise<void> {
    const cwd = process.cwd();
    const ontologyPath = resolve(cwd, ONTOLOGY_IR_PATH);
    const generatedDir = resolve(cwd, GENERATED_DIR_PATH);
    const program = new Command();

    program.name("ontology").description("Generate and pull ontology files");

    program
        .command("generate")
        .description("Generate typed live ontology helpers from src/ontology/ontology.ts")
        .option("--no-js-extensions", "Omit .js extensions from generated relative imports")
        .action(async (options: { jsExtensions?: boolean }) => {
            await generateFiles({
                ontology: ontologyPath,
                outDir: generatedDir,
                namespace: readPackageNamespace(cwd),
                jsExtensions: options.jsExtensions,
            });
        });

    const configPath = discoverOntologyConfigPath(cwd);
    if (configPath) {
        const config = await loadOntologyConfig(configPath);
        program
            .command("pull")
            .description(`Pull ontology metadata using ${ONTOLOGY_CONFIG_PATH}`)
            .action(async () => {
                await writePulledOntology(config, ontologyPath);
                console.log(`Generated ontology written to: ${ontologyPath}`);
            });
    }

    await program.parseAsync();
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
