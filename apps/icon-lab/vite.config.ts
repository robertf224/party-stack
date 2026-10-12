import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineAppConfig } from "@party-stack/build-config";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { lazyPlugins } from "vite-plus";
import type { Plugin, PreviewServer, ViteDevServer } from "vite-plus";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const generatedDataDir = path.join(rootDir, "temp", "data");
const generatedFiles = [
    "catalog.json",
    "draft-mappings.json",
    "embeddings-index.json",
    "embeddings.i8",
    "mapping-audit.json",
    "sfsymbols.local.zip",
] as const;

function generatedDataPlugin(): Plugin {
    function serveGeneratedData(server: ViteDevServer | PreviewServer) {
        server.middlewares.use("/generated-data", async (request, response, next) => {
            const fileName = path.basename(request.url?.split("?")[0] ?? "");
            if (!generatedFiles.includes(fileName as (typeof generatedFiles)[number])) {
                next();
                return;
            }
            try {
                response.setHeader(
                    "Content-Type",
                    fileName.endsWith(".json") ? "application/json" : "application/octet-stream"
                );
                response.end(await readFile(path.join(generatedDataDir, fileName)));
            } catch {
                next();
            }
        });
    }

    return {
        name: "icon-lab-generated-data",
        configureServer(server) {
            serveGeneratedData(server);
            server.middlewares.use("/__save-mapping-feedback", (request, response, next) => {
                if (request.method !== "POST") {
                    next();
                    return;
                }
                let body = "";
                request.setEncoding("utf8");
                request.on("data", (chunk: string) => {
                    body += chunk;
                });
                request.on("end", async () => {
                    try {
                        const parsed = JSON.parse(body) as {
                            version?: unknown;
                            feedback?: unknown;
                        };
                        if (parsed.version !== 1 || !Array.isArray(parsed.feedback)) {
                            throw new Error("Invalid mapping feedback file");
                        }
                        await writeFile(
                            path.join(generatedDataDir, "icon-mapping-feedback.json"),
                            `${JSON.stringify(parsed, null, 2)}\n`
                        );
                        response.setHeader("Content-Type", "application/json");
                        response.end(JSON.stringify({ saved: true }));
                    } catch (error) {
                        response.statusCode = 400;
                        response.end(error instanceof Error ? error.message : "Could not save feedback");
                    }
                });
            });
        },
        configurePreviewServer(server) {
            serveGeneratedData(server);
        },
        async generateBundle() {
            let missingData = false;
            for (const fileName of generatedFiles) {
                if (fileName === "sfsymbols.local.zip") {
                    continue;
                }
                let source: Buffer;
                try {
                    source = await readFile(path.join(generatedDataDir, fileName));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }
                    missingData = true;
                    continue;
                }
                this.emitFile({
                    type: "asset",
                    fileName: `generated-data/${fileName}`,
                    source,
                });
            }
            if (missingData) {
                this.warn(
                    "Icon Lab data is not prepared. Run vp run @party-stack/icon-lab#icons:embed before using the app."
                );
            }
        },
    };
}

export default defineAppConfig({
    run: {
        tasks: {
            "icons:archive": {
                command: "tsx scripts/extract-assets.ts",
                cache: false,
                dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
            },
            "icons:catalog": {
                command: "tsx scripts/extract-assets.ts --catalog-only",
                cache: {
                    env: ["SF_SYMBOLS_ASSET_DIR"],
                    input: [{ auto: true }, "!.", "*.{json,jsonc,ts,mts,js,mjs}", "!temp", "!temp/**"],
                    output: ["temp/data/catalog.json", "temp/data/sfsymbols.local.zip"],
                },
                dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
            },
            "icons:embed": {
                command: "tsx scripts/generate-embeddings.ts",
                // Cache generated artifacts independently of the downloaded model cache.
                cache: {
                    env: ["SF_SYMBOLS_ASSET_DIR"],
                    input: [
                        "../../pnpm-lock.yaml",
                        "../../package.json",
                        "*.json",
                        "scripts/**",
                        "src/shared/**",
                        "public/icon-sets/**",
                        "temp/data/catalog.json",
                        "temp/data/sfsymbols.local.zip",
                    ],
                    output: [
                        "temp/data/embeddings.i8",
                        "temp/data/embeddings-index.json",
                        "temp/data/mapping-audit.json",
                        "temp/data/draft-mappings.json",
                    ],
                },
                dependsOn: ["icons:catalog"],
            },
        },
    },

    server: {
        host: true,
    },
    test: { environment: "node" },
    plugins: lazyPlugins(() => [react(), tailwindcss(), generatedDataPlugin()]),
    resolve: {
        alias: {
            "@": path.resolve(rootDir, "src"),
        },
    },
});
