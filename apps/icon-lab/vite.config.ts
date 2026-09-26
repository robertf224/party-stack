import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

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
            for (const fileName of generatedFiles) {
                if (fileName === "sfsymbols.local.zip") {
                    continue;
                }
                this.emitFile({
                    type: "asset",
                    fileName: `generated-data/${fileName}`,
                    source: await readFile(path.join(generatedDataDir, fileName)),
                });
            }
        },
    };
}

export default defineConfig({
    server: {
        port: 5179,
        host: true,
    },
    plugins: [react(), tailwindcss(), generatedDataPlugin()],
    resolve: {
        alias: {
            "@": path.resolve(rootDir, "src"),
        },
    },
});
