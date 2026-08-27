import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import { createJiti } from "jiti";
import { format, resolveConfig } from "prettier";
import { generateOntology } from "../generate/ontology.js";
import { createMetaLiveOntology } from "../meta/generated/live.js";
import { pull } from "../meta/pull.js";
import type {
    OntologyPullSource,
    OntologyPullConfig,
} from "../OntologyPullConfig.js";

const { loadEnvConfig } = nextEnv;

export const ONTOLOGY_PULL_CONFIG_PATH =
    "src/ontology/config.ts";
export const ONTOLOGY_IR_PATH = "src/ontology/ontology.ts";

type ConfigModule = Record<string, unknown> & { default?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isOntologyPullSource(
    value: unknown
): value is OntologyPullSource {
    return (
        isRecord(value) &&
        typeof value.createBackend ===
            "function"
    );
}

function isOntologyPullConfig(
    value: unknown
): value is OntologyPullConfig {
    return (
        isRecord(value) &&
        isOntologyPullSource(value.source) &&
        Array.isArray(value.objectTypeNames) &&
        value.objectTypeNames.every((entry) => typeof entry === "string") &&
        Array.isArray(value.actionTypeNames) &&
        value.actionTypeNames.every((entry) => typeof entry === "string") &&
        (value.queryFunctionTypeNames === undefined ||
            (Array.isArray(value.queryFunctionTypeNames) &&
                value.queryFunctionTypeNames.every((entry) => typeof entry === "string")))
    );
}

export function discoverOntologyPullConfigPath(
    cwd: string
): string | null {
    const configPath = resolve(
        cwd,
        ONTOLOGY_PULL_CONFIG_PATH
    );
    return existsSync(configPath) ? configPath : null;
}

export async function loadOntologyPullConfig(
    configPath: string
): Promise<OntologyPullConfig> {
    loadEnvConfig(resolve(dirname(configPath), "../.."));

    const jiti = createJiti(import.meta.url);
    const configModule: ConfigModule = await jiti.import(configPath);
    const config = configModule.default;

    if (!isOntologyPullConfig(config)) {
        throw new Error(
            `Config file "${configPath}" must default export an OntologyPullConfig value.`
        );
    }

    return config;
}

export async function writePulledOntology(
    config: OntologyPullConfig,
    outPath: string,
    ontologyImportPath = "@party-stack/ontology"
): Promise<void> {
    const backendAdapter =
        await config.source.createBackend(
            config.options
        );
    const liveOntology = await createMetaLiveOntology({
        backend: () => backendAdapter,
    });

    try {
        const pulledOntology = await pull(liveOntology, {
            objectTypeNames: config.objectTypeNames,
            actionTypeNames: config.actionTypeNames,
            queryFunctionTypeNames: config.queryFunctionTypeNames ?? [],
        });
        const ontology = config.source
            .transformPulledOntology
            ? await config.source.transformPulledOntology(
                  pulledOntology,
                  config.options
              )
            : pulledOntology;
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
