import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineLibraryConfig, type LibraryConfig } from "@party-stack/build-config";

export default defineLibraryConfig({
    run: {
        tasks: {
            test: {
                command: "WRANGLER_WRITE_LOGS=0 vp exec vitest run && node scripts/verify-worker-bundle.mjs",
            },
        },
    },

    test: {
        include: ["test/**/*.test.ts"],
        // workerd cannot read Vitest 5.0.4's host module-cache files yet.
        // https://github.com/cloudflare/workers-sdk/pull/16163
        fsModuleCache: false,
    },
    // Keep the Cloudflare/Vitest plugin type at the shared Vite config boundary;
    // comparing both recursive config types can exceed TypeScript's depth limit.
    plugins: [
        cloudflareTest({
            wrangler: {
                configPath: "./wrangler.jsonc",
            },
        }),
    ] as LibraryConfig["plugins"],
});
