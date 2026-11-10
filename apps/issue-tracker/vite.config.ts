import { defineAppConfig } from "@party-stack/tanstack-start-build-config";
import { lazyPlugins } from "vite-plus";

export default defineAppConfig({
    // Task discovery runs before workspace dependencies have built their exports.
    plugins: lazyPlugins(async () => {
        const { demandAttribution } = await import("@party-stack/ontology-devtools/vite");
        return [demandAttribution()];
    }),
    server: { port: 3000 },
    ssr: { external: ["better-sqlite3"] },
});
