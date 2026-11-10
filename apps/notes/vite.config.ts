import { demandAttribution } from "@party-stack/ontology-devtools/vite";
import { defineAppConfig } from "@party-stack/tanstack-start-build-config";
import { userTraceRecorder } from "./user-trace-plugin";

export default defineAppConfig({
    cacheDir: process.env.VITE_NOTES_STORAGE === "sqlite-opfs" ? "node_modules/.vite-sqlite-opfs" : undefined,
    plugins: [demandAttribution(), userTraceRecorder()],
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
