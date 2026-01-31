#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { createJiti } from "jiti";
import { generateBuilders } from "./builders.js";
import { generateSchema } from "./schema.js";
import { generateTypes } from "./types.js";
import type { SchemaIR } from "../ir/ir.js";

const program = new Command();

program
    .name("generate")
    .description("Generate Zod schemas and builders from a SchemaIR file")
    .requiredOption("--schema <path>", "Path to the schema IR file (default export should be SchemaIR)")
    .requiredOption("--exportName <name>", "Name of the main builder export (e.g., 'p' for p.string())")
    .option("--promoted <typeName>", "Union type to promote to top-level builders")
    .requiredOption(
        "--outDir <path>",
        "Directory to write the generated output files (schema.ts and builders.ts)"
    )
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
        const schemaOutput = generateSchema(schema);
        const typesOutput = generateTypes(schema);
        const buildersOutput = generateBuilders(schema, {
            exportName: options.exportName,
            promoted: options.promoted,
        });

        // Ensure output directory exists
        mkdirSync(outDir, { recursive: true });

        const header = "// Auto-generated file - do not edit manually\n\n";

        // Write the output files
        const schemaFilePath = join(outDir, "schema.ts");
        const typesFilePath = join(outDir, "types.ts");
        const buildersFilePath = join(outDir, "builders.ts");

        writeFileSync(schemaFilePath, header + schemaOutput, "utf-8");
        writeFileSync(typesFilePath, header + typesOutput, "utf-8");
        writeFileSync(buildersFilePath, header + buildersOutput, "utf-8");

        console.log(`Generated schema written to: ${schemaFilePath}`);
        console.log(`Generated types written to: ${typesFilePath}`);
        console.log(`Generated builders written to: ${buildersFilePath}`);
    });

program.parse();
