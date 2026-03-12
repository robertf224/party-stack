import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateOntology } from "../generate/ontology.js";
import { pull } from "../meta/pull.js";
import { createMetaLiveOntology } from "../ontology/generated/live.js";
import type { OntologyConfigAdapter, OntologyConfig } from "../OntologyConfig.js";

const { loadEnvConfig } = nextEnv;

export const ONTOLOGY_CONFIG_PATH = "src/ontology/config.ts";
export const ONTOLOGY_IR_PATH = "src/ontology/ontology.ts";

type ConfigModule = Record<string, unknown> & { default?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isOntologyConfigAdapter(value: unknown): value is OntologyConfigAdapter {
    return isRecord(value) && typeof value.createAdapter === "function";
}

function isOntologyConfig(value: unknown): value is OntologyConfig {
    return (
        isRecord(value) &&
        isOntologyConfigAdapter(value.adapter) &&
        Array.isArray(value.objectTypeNames) &&
        value.objectTypeNames.every((entry) => typeof entry === "string")
    );
}

export function discoverOntologyConfigPath(cwd: string): string | null {
    const configPath = resolve(cwd, ONTOLOGY_CONFIG_PATH);
    return existsSync(configPath) ? configPath : null;
}

export async function loadOntologyConfig(configPath: string): Promise<OntologyConfig> {
    loadEnvConfig(resolve(dirname(configPath), "../.."));

    const jiti = createJiti(import.meta.url);
    const configModule: ConfigModule = await jiti.import(configPath);
    const config = configModule.default;

    if (!isOntologyConfig(config)) {
        throw new Error(`Config file "${configPath}" must default export an OntologyConfig value.`);
    }

    return config;
}

export async function writePulledOntology(
    config: OntologyConfig,
    outPath: string,
    ontologyImportPath = "@party-stack/ontology"
): Promise<void> {
    const adapter = await config.adapter.createAdapter(config.opts);
    const liveOntology = createMetaLiveOntology(adapter);

    try {
        const ontology = await pull(liveOntology, config.objectTypeNames);
        const output = generateOntology(ontology, { ontologyImportPath });

        mkdirSync(dirname(outPath), { recursive: true });

        const prettierConfig = await resolveConfig(dirname(outPath));
        const formatted = await format(`// Auto-generated file - do not edit manually\n\n${output}`, {
            ...prettierConfig,
            filepath: outPath,
        });

        writeFileSync(outPath, formatted, "utf-8");
    } finally {
        await liveOntology.cleanup();
    }
}
