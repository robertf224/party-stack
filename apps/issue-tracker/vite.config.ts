import { demandAttribution } from "@party-stack/ontology-devtools/vite";
import { defineAppConfig } from "@party-stack/tanstack-start-build-config";

export default defineAppConfig({
    plugins: [demandAttribution()],
    server: { port: 3000 },
    ssr: {
        external: ["better-sqlite3"],
    },
});
