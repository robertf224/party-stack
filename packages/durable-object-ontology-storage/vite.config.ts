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
        // workerd also reports ctx.abort to its runner. Only the two intentional
        // crash-test resets are expected; RPC rejection and durable recovery are asserted.
        onUnhandledError: (error) => {
            if (
                "durableObjectReset" in error &&
                error.durableObjectReset === true &&
                (error.message === "Intentional crash after R2 write" ||
                    error.message === "Intentional crash during scoped read")
            )
                return false;
        },
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
