import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
    entryPoints: ["fixtures/worker.ts"],
    absWorkingDir: packageRoot,
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import"],
    external: ["cloudflare:*", "node:*"],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outdir: "out",
    platform: "browser",
    target: "es2022",
    write: false,
});

const forbiddenInputs = Object.keys(result.metafile.inputs).filter(
    (input) => input.includes("better-sqlite3") || input.startsWith("node:")
);
// Inspect module dependencies, not arbitrary strings. Effect safely probes for an
// optional Node AsyncResource through globalThis.process?.getBuiltinModule?.(...).
const forbiddenImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.path.startsWith("node:") || entry.path.includes("better-sqlite3"))
    .map((entry) => entry.path);
if (forbiddenInputs.length > 0 || forbiddenImports.length > 0) {
    throw new Error(
        `Worker bundle contains Node-only dependencies: ${[...forbiddenInputs, ...forbiddenImports].join(", ")}`
    );
}
// The Alchemy compiler emits a runtime-only fixture. node:os is a supported
// workerd compatibility import currently retained by Alchemy's auth helpers.
// Its CLI bootstrap also retains four lazy platform imports; runtime tests must
// exercise the R2 clients without evaluating that bootstrap.
const optionalPlatformImports = new Set([
    "@effect/platform-bun/BunServices",
    "@effect/platform-bun/BunSocket",
    "@effect/platform-node/NodeServices",
    "@effect/platform-node/NodeSocket",
]);
const alchemy = await build({
    entryPoints: ["temp/worker.js"],
    absWorkingDir: packageRoot,
    bundle: true,
    external: ["cloudflare:*", "node:*", ...optionalPlatformImports],
    platform: "browser",
    format: "esm",
    metafile: true,
    write: false,
    logLevel: "silent",
});
const unexpected = Object.values(alchemy.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
        (entry) =>
            !entry.path.startsWith("cloudflare:") &&
            entry.path !== "node:os" &&
            !(entry.kind === "dynamic-import" && optionalPlatformImports.has(entry.path))
    );
if (unexpected.length)
    throw new Error(
        `Alchemy Worker has unsupported runtime imports: ${unexpected.map((entry) => entry.path).join(", ")}`
    );
console.log("Durable Object ontology bundles are Worker-safe.");
