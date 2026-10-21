import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
    entryPoints: ["fixtures/worker.ts", "test/worker.ts"],
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
console.log("Durable Object ontology bundle is Worker-safe.");
