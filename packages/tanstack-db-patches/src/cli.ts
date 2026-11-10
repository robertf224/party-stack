#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { check, setup } from "./setup.js";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const options = {
    cwd: Flag.String("cwd").pipe(
        Flag.withDefault(process.cwd()),
        Flag.withDescription("Project or workspace directory")
    ),
    coreOnly: Flag.Boolean("core-only").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Configure core DB only, without React DB")
    ),
    local: Flag.Boolean("local").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Use this checked-in/vendored package inside the target workspace")
    ),
};
const install = Command.make(
    "setup",
    {
        ...options,
        install: Flag.Boolean("install").pipe(
            Flag.withDefault(true),
            Flag.withDescription("Run pnpm install after setup; --no-install only writes configuration")
        ),
    },
    (flags) =>
        setup({ ...flags, packageDir }).pipe(Effect.mapError((cause) => new CliError.UserError({ cause })))
).pipe(Command.withDescription("Register the shared patches using native project-local pnpm configuration"));
const verify = Command.make("check", options, (flags) =>
    check({ ...flags, packageDir }).pipe(Effect.mapError((cause) => new CliError.UserError({ cause })))
).pipe(Command.withDescription("Verify native patch configuration and the installed upstream packages"));

Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkg = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
    )(yield* fs.readFileString(fileURLToPath(new URL("../package.json", import.meta.url))));
    yield* Command.make("tanstack-db-patches").pipe(
        Command.withDescription(
            "Install Party Stack's tested TanStack DB patches without a custom pnpm hook"
        ),
        Command.withSubcommands([install, verify]),
        Command.run({ version: pkg.version })
    );
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
