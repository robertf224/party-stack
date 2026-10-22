import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "alchemy/Bundle/Bundle";
import { Effect } from "effect";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtins = new Set(builtinModules);
// Alchemy's normal runtime compiler removes its deployment-only dependency graph.
// Vitest's unbundled module runner otherwise tries to execute that graph in workerd.
const result = await Effect.runPromise(
    build(
        {
            cwd: packageRoot,
            input: "test/worker.ts",
            platform: "browser",
            resolve: { conditionNames: ["workerd", "worker", "browser", "default"] },
            external: (id) =>
                id.startsWith("cloudflare:") ||
                id.startsWith("node:") ||
                builtins.has(id) ||
                id.startsWith("@effect/platform-node/") ||
                id.startsWith("@effect/platform-bun/"),
        },
        { format: "esm", codeSplitting: false }
    )
);
await mkdir(resolve(packageRoot, "temp"), { recursive: true });
for (const file of result.files) {
    await writeFile(resolve(packageRoot, "temp", file.path), file.content);
}
