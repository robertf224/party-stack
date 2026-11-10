import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import { pull } from "@party-stack/ontology-backend/meta";
import { generateOntology } from "@party-stack/ontology-spec/generate";
import { formatGeneratedFile } from "@party-stack/ontology-spec/generate";
import { Effect, Predicate } from "effect";
import { createJiti } from "jiti";
import type { OntologyPullContext, OntologyPullConfig } from "../OntologyPullConfig.js";

const { loadEnvConfig } = nextEnv;

export const ONTOLOGY_PULL_CONFIG_PATH = "src/ontology/config.ts";
export const ONTOLOGY_IR_PATH = "src/ontology/ontology.ts";

type ConfigModule = Record<string, unknown> & { default?: unknown };

function isOntologyPullConfig(value: unknown): value is OntologyPullConfig {
    return (
        Predicate.isObject(value) &&
        Effect.isEffect(value.backend) &&
        (value.transformPulledOntology === undefined ||
            typeof value.transformPulledOntology === "function") &&
        Array.isArray(value.objectTypeNames) &&
        value.objectTypeNames.every((entry) => typeof entry === "string") &&
        Array.isArray(value.actionTypeNames) &&
        value.actionTypeNames.every((entry) => typeof entry === "string") &&
        (value.queryFunctionTypeNames === undefined ||
            (Array.isArray(value.queryFunctionTypeNames) &&
                value.queryFunctionTypeNames.every((entry) => typeof entry === "string")))
    );
}

export function discoverOntologyPullConfigPath(cwd: string): string | null {
    const configPath = resolve(cwd, ONTOLOGY_PULL_CONFIG_PATH);
    return existsSync(configPath) ? configPath : null;
}

export async function loadOntologyPullConfig(configPath: string): Promise<OntologyPullConfig> {
    loadEnvConfig(resolve(dirname(configPath), "../.."));

    const jiti = createJiti(import.meta.url);
    const configModule: ConfigModule = await jiti.import(configPath);
    const config = configModule.default;

    if (!isOntologyPullConfig(config)) {
        throw new Error(`Config file "${configPath}" must default export an OntologyPullConfig value.`);
    }

    return config;
}

export async function writePulledOntology(
    config: OntologyPullConfig,
    outPath: string,
    context: OntologyPullContext,
    ontologyImportPath = "@party-stack/ontology-spec"
): Promise<void> {
    const ontology = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* config.backend;
                return yield* pull(backend, {
                    objectTypeNames: config.objectTypeNames,
                    actionTypeNames: config.actionTypeNames,
                    queryFunctionTypeNames: config.queryFunctionTypeNames ?? [],
                    transformPulledOntology: config.transformPulledOntology,
                });
            })
        ).pipe(Effect.provide(context.runtime))
    );
    const output = generateOntology(ontology, { ontologyImportPath });

    mkdirSync(dirname(outPath), { recursive: true });

    const formatted = await formatGeneratedFile(outPath, output);

    writeFileSync(outPath, formatted, "utf-8");
}
