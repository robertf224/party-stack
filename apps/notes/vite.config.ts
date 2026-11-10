import { defineAppConfig } from "@party-stack/tanstack-start-build-config";
import { lazyPlugins } from "vite-plus";
import { userTraceRecorder } from "./user-trace-plugin";

export default defineAppConfig({
    cacheDir: process.env.VITE_NOTES_STORAGE === "sqlite-opfs" ? "node_modules/.vite-sqlite-opfs" : undefined,
    // Task discovery runs before workspace dependencies have built their exports.
    plugins: lazyPlugins(async () => {
        const { demandAttribution } = await import("@party-stack/ontology-devtools/vite");
        return [demandAttribution(), userTraceRecorder()];
    }),
    ssr: { external: ["better-sqlite3", "@napi-rs/keyring"] },
    optimizeDeps: {
        exclude: [
            "@napi-rs/keyring",
            ...(process.env.VITE_NOTES_STORAGE === "sqlite-opfs"
                ? ["@effect/sql-sqlite-wasm", "@effect/wa-sqlite"]
                : []),
        ],
    },
});
