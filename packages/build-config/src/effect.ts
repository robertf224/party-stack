import { recommended } from "@effect/tsgo/oxlint-presets";
import { mergeConfig, type ViteUserConfig } from "vite-plus";
import { defineLibraryConfig, type LibraryConfig } from "./index.js";

/** Opt in to Effect's type-aware diagnostics without changing ordinary libraries. */
export function defineEffectLibraryConfig(config: LibraryConfig = {}): ViteUserConfig {
    return defineLibraryConfig({
        ...config,
        test: mergeConfig(
            {
                alias: [{ find: /^vitest$/, replacement: "vite-plus/test" }],
                server: { deps: { inline: ["@effect/vitest"] } },
            },
            config.test ?? {}
        ),
        lint: {
            ...config.lint,
            extends: [recommended, ...(config.lint?.extends ?? [])],
            rules: {
                "vitest/no-standalone-expect": [
                    "warn",
                    {
                        additionalTestBlockFunctions: [
                            "it.effect",
                            "it.effect.prop",
                            "it.live",
                            "it.live.prop",
                        ],
                    },
                ],
                ...config.lint?.rules,
            },
        },
    });
}
