#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pascalCase } from "change-case";
import { Command } from "commander";
import { generateFiles } from "./generate.js";
const ONTOLOGY_IR_PATH = "src/ontology/ontology.ts";

const GENERATED_DIR_PATH = "src/ontology/generated";

function readPackageNamespace(cwd: string): string {
    const packageJsonPath = resolve(cwd, "package.json");
    if (!existsSync(packageJsonPath)) {
        return pascalCase(basename(cwd));
    }

    try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
        const packageName =
            typeof packageJson.name === "string"
                ? (packageJson.name.split("/").pop() ?? packageJson.name)
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

    program.name("ontology-spec").description("Generate ontology specification files");

    program
        .command("generate")
        .description("Generate ontology types, builders, and live helpers")
        .option("--ontology <path>", "Path to the ontology module", ontologyPath)
        .option("--outDir <path>", "Directory to write generated files", generatedDir)
        .option("--namespace <name>", "Namespace for generated ontology types/factories")
        .option("--effect", "Generate opt-in Effect validators in effect.ts")
        .option("--no-live", "Generate definitions without live runtime helpers")
        .option("--no-js-extensions", "Omit .js extensions from generated relative imports")
        .action(
            async (options: {
                ontology: string;
                outDir: string;
                namespace?: string;
                jsExtensions?: boolean;
                live?: boolean;
                effect?: boolean;
            }) => {
                await generateFiles({
                    ontology: resolve(cwd, options.ontology),
                    outDir: resolve(cwd, options.outDir),
                    namespace: options.namespace ?? readPackageNamespace(cwd),
                    jsExtensions: options.jsExtensions,
                    emitLive: options.live,
                    emitEffectSchemas: options.effect,
                });
            }
        );

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
