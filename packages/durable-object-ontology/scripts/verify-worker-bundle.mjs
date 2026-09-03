import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const output = result.outputFiles.map((file) => file.text).join("\n");
if (forbiddenInputs.length > 0 || output.includes("better-sqlite3") || /["']node:[^"']+["']/.test(output)) {
    throw new Error(`Worker bundle contains Node-only inputs: ${forbiddenInputs.join(", ")}`);
}
console.log("Durable Object ontology bundle is Worker-safe.");
