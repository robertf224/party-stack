#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { makeGenerateCommand } from "@party-stack/ontology-spec/generate";
import { Console, Effect } from "effect";
import { CliError, Command } from "effect/cli";
import {
    ONTOLOGY_PULL_CONFIG_PATH,
    ONTOLOGY_IR_PATH,
    discoverOntologyPullConfigPath,
    loadOntologyPullConfig,
    writePulledOntology,
} from "./pull.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
};

const configPath = discoverOntologyPullConfigPath(process.cwd());
const pull = Command.make("pull", {}, () =>
    Effect.tryPromise({
        try: async () => {
            if (!configPath) throw new Error(`Create ${ONTOLOGY_PULL_CONFIG_PATH} before pulling metadata.`);
            const config = await loadOntologyPullConfig(configPath);
            const { nodeRuntime } = await import("@party-stack/node-runtime");
            const path = resolve(process.cwd(), ONTOLOGY_IR_PATH);
            await writePulledOntology(config, path, { runtime: nodeRuntime() });
            return path;
        },
        catch: (cause) => new CliError.UserError({ cause }),
    }).pipe(Effect.flatMap((path) => Console.log(`Generated ontology written to: ${path}`)))
).pipe(Command.withDescription(`Pull ontology metadata using ${ONTOLOGY_PULL_CONFIG_PATH}`));

Command.make("ontology").pipe(
    Command.withDescription("Generate and pull ontology files"),
    Command.withSubcommands([
        makeGenerateCommand({ valuesImportPath: "@party-stack/ontology/values" }),
        ...(configPath ? [pull] : []),
    ]),
    Command.run({ version }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain
);
