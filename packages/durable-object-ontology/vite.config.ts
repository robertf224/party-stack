import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineLibraryConfig } from "@party-stack/build-config";

export default defineLibraryConfig({
    run: {
        tasks: {
            test: {
                command: "WRANGLER_WRITE_LOGS=0 vp exec vitest run && node scripts/verify-worker-bundle.mjs",
            },
        },
    },

    test: { include: ["test/**/*.test.ts"] },
    plugins: [
        cloudflareTest({
            wrangler: {
                configPath: "./wrangler.jsonc",
            },
        }),
    ],
});
