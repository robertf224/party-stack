#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateOntology } from "../generate/ontology.js";
import { createMetaLiveOntology } from "../meta/generated/live.js";
import { pull } from "../meta/pull.js";
import type { OntologyAdapter } from "../OntologyAdapter.js";

type AdapterModule = Record<string, unknown> & { default?: unknown };

const program = new Command();

function isOntologyAdapter(value: unknown): value is OntologyAdapter {
    return (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        typeof value.name === "string" &&
        "getSyncConfig" in value &&
        typeof value.getSyncConfig === "function"
    );
}

program
    .name("pull")
    .description("Pull ontology metadata through an adapter and generate an ontology.ts file")
    .requiredOption("--adapter <path>", "Path to module exporting an OntologyAdapter")
    .option("--adapterExport <name>", "Export name to load from the adapter module", "default")
    .requiredOption("--objectTypes <names...>", "Object type names to pull")
    .requiredOption("--out <path>", "Path to write the generated ontology file")
    .option(
        "--ontologyImportPath <path>",
        "Module specifier to import `o` and `OntologyIR` from",
        "@party-stack/ontology"
    )
    .action(
        async (options: {
            adapter: string;
            adapterExport: string;
            objectTypes: string[];
            out: string;
            ontologyImportPath: string;
        }) => {
            const adapterPath = resolve(process.cwd(), options.adapter);
            const outPath = resolve(process.cwd(), options.out);
            const jiti = createJiti(import.meta.url);
            const adapterModule: AdapterModule = await jiti.import(adapterPath);
            const adapterExport =
                options.adapterExport === "default"
                    ? adapterModule.default
                    : adapterModule[options.adapterExport];

            if (!isOntologyAdapter(adapterExport)) {
                console.error(
                    `Error: Adapter export "${options.adapterExport}" from "${options.adapter}" must be an OntologyAdapter`
                );
                process.exit(1);
            }

            const ontology = await pull(createMetaLiveOntology(adapterExport), options.objectTypes);
            const output = generateOntology(ontology, {
                ontologyImportPath: options.ontologyImportPath,
            });

            mkdirSync(dirname(outPath), { recursive: true });

            const prettierConfig = await resolveConfig(dirname(outPath));
            const formatted = await format(`// Auto-generated file - do not edit manually\n\n${output}`, {
                ...prettierConfig,
                filepath: outPath,
            });

            writeFileSync(outPath, formatted, "utf-8");
            console.log(`Generated ontology written to: ${outPath}`);
        }
    );

program.parse();
