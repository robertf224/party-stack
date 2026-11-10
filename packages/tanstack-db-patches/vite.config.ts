import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";

// Config dependencies cannot have runtime dependencies. Bundle the Effect CLI;
// pnpm itself consumes the separate, unchanged patch files during installation.
export default defineEffectLibraryConfig({
    pack: {
        entry: ["src/cli.ts"],
        unbundle: false,
        dts: false,
        deps: { alwaysBundle: [/.*/], neverBundle: [/^node:/] },
    },
    run: {
        tasks: {
            "verify-distribution": {
                command: "node scripts/verify-distribution.mjs",
                dependsOn: ["build"],
                cache: false,
            },
        },
    },
});
