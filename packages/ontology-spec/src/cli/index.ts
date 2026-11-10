#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { makeGenerateCommand } from "./generateCommand.js";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
};

Command.make("ontology-spec").pipe(
    Command.withDescription("Generate ontology specification files"),
    Command.withSubcommands([makeGenerateCommand()]),
    Command.run({ version }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain
);
