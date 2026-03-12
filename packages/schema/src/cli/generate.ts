#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateBuilders } from "../generate/builders.js";
import { generateTypes } from "../generate/types.js";
import { generateValidators } from "../generate/validators.js";
import type { SchemaIR } from "../ir/index.js";

function toModuleSpecifier(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith(".")) {
        return normalized;
    }
    return `./${normalized}`;
}

function formatImportSpecifier(path: string): string {
    return toModuleSpecifier(path).replace(/\.[cm]?tsx?$/, ".js");
}

function resolveValuesImportPath(outDir: string): string {
    const workspaceValuesPath = fileURLToPath(new URL("../../src/utils/values.ts", import.meta.url));
    if (!existsSync(workspaceValuesPath)) {
        return "@party-stack/schema/values";
    }
    return formatImportSpecifier(relative(outDir, workspaceValuesPath));
}

const program = new Command();

program
    .name("generate")
    .description("Generate Zod schemas and builders from a SchemaIR file")
    .requiredOption("--schema <path>", "Path to the schema IR file (default export should be SchemaIR)")
    .requiredOption("--exportName <name>", "Name of the main builder export (e.g., 'p' for p.string())")
    .option("--promoted <typeName>", "Union type to promote to top-level builders")
    .requiredOption("--outDir <path>", "Directory to write the generated output files")
    .action(async (options: { schema: string; exportName: string; promoted?: string; outDir: string }) => {
        const schemaPath = resolve(process.cwd(), options.schema);
        const outDir = resolve(process.cwd(), options.outDir);

        // Use jiti to load the schema file (supports TypeScript)
        const jiti = createJiti(import.meta.url);
        const schemaModule = await jiti.import(schemaPath);
        const schema = (schemaModule as { default: SchemaIR }).default;

        if (!schema || !schema.types) {
            console.error("Error: Schema file must have a default export of type SchemaIR");
            process.exit(1);
        }

        // Generate schema, types, and builders
        const typesOutput = generateTypes(schema, {
            valuesImportPath: resolveValuesImportPath(outDir),
        });
        const validatorsOutput = generateValidators(schema);
        const buildersOutput = generateBuilders(schema, {
            exportName: options.exportName,
            promoted: options.promoted,
        });

        // Ensure output directory exists
        mkdirSync(outDir, { recursive: true });

        const header = "// Auto-generated file - do not edit manually\n\n";

        // Write the output files
        const typesFilePath = join(outDir, "types.ts");
        const validatorsFilePath = join(outDir, "validators.ts");
        const buildersFilePath = join(outDir, "builders.ts");

        // Resolve prettier config from the output directory (uses consumer's config)
        const prettierConfig = await resolveConfig(outDir);

        // Format and write each file
        const formatAndWrite = async (filePath: string, content: string) => {
            const formatted = await format(header + content, {
                ...prettierConfig,
                filepath: filePath, // Helps prettier infer parser
            });
            writeFileSync(filePath, formatted, "utf-8");
        };

        await Promise.all([
            formatAndWrite(typesFilePath, typesOutput),
            formatAndWrite(validatorsFilePath, validatorsOutput),
            formatAndWrite(buildersFilePath, buildersOutput),
        ]);

        console.log(`Generated types written to: ${typesFilePath}`);
        console.log(`Generated validators written to: ${validatorsFilePath}`);
        console.log(`Generated builders written to: ${buildersFilePath}`);
    });

program.parse();
