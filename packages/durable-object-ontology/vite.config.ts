import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { type LibraryConfig } from "@party-stack/build-config";
import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";

export default defineEffectLibraryConfig({
    run: {
        tasks: {
            test: {
                command:
                    "vp exec node scripts/prepare-test-worker.mjs && WRANGLER_WRITE_LOGS=0 vp exec vitest run && node scripts/verify-worker-bundle.mjs",
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
