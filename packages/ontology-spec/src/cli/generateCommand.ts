import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pascalCase } from "change-case";
import { Effect } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { generateFiles } from "./generate.js";
import type { GenerateFilesOpts } from "./generate.js";

function packageNamespace(cwd: string): string {
    const path = resolve(cwd, "package.json");
    if (existsSync(path)) {
        try {
            const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
            if (typeof pkg.name === "string") return pascalCase(pkg.name.split("/").pop()!);
        } catch {
            // A package name is optional; generation still works outside a package.
        }
    }
    return pascalCase(basename(cwd));
}

/** Shared flags/handler for the standalone spec CLI and the SDK CLI. */
export function makeGenerateCommand(defaults: Pick<GenerateFilesOpts, "valuesImportPath"> = {}) {
    const cwd = process.cwd();
    return Command.make(
        "generate",
        {
            ontology: Flag.String("ontology").pipe(
                Flag.withDescription("Path to the ontology module"),
                Flag.withDefault("src/ontology/ontology.ts")
            ),
            outDir: Flag.String("outDir").pipe(
                Flag.withDescription("Directory to write generated files"),
                Flag.withDefault("src/ontology/generated")
            ),
            namespace: Flag.String("namespace").pipe(
                Flag.withDescription("Namespace for generated ontology types/factories"),
                Flag.withDefault(packageNamespace(cwd))
            ),
            effect: Flag.Boolean("effect").pipe(
                Flag.withDescription("Generate opt-in Effect validators in effect.ts"),
                Flag.withDefault(false)
            ),
            live: Flag.Boolean("live").pipe(
                Flag.withDescription("Generate live runtime helpers; --no-live omits them"),
                Flag.withDefault(true)
            ),
            jsExtensions: Flag.Boolean("js-extensions").pipe(
                Flag.withDescription("Use .js relative imports; --no-js-extensions omits extensions"),
                Flag.withDefault(true)
            ),
        },
        (options) =>
            Effect.tryPromise({
                try: () =>
                    generateFiles({
                        ...defaults,
                        ontology: resolve(cwd, options.ontology),
                        outDir: resolve(cwd, options.outDir),
                        namespace: options.namespace,
                        jsExtensions: options.jsExtensions,
                        emitLive: options.live,
                        emitEffectSchemas: options.effect,
                    }),
                catch: (cause) => new CliError.UserError({ cause }),
            })
    ).pipe(Command.withDescription("Generate ontology types, builders, and live helpers"));
}
