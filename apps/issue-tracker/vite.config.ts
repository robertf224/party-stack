import { defineAppConfig } from "@party-stack/tanstack-start-build-config";

export default defineAppConfig({
    server: { port: 3000 },
    ssr: {
        external: ["better-sqlite3"],
    },
});
