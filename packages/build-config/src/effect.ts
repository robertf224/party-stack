import { recommended } from "@effect/tsgo/oxlint-presets";
import { mergeConfig } from "vite-plus";
import { defineLibraryConfig, type LibraryConfig } from "./index.js";

/** Opt in to Effect's type-aware diagnostics without changing ordinary libraries. */
export function defineEffectLibraryConfig(config: LibraryConfig = {}) {
    return defineLibraryConfig({
        ...config,
        test: mergeConfig(
            {
                alias: { vitest: "vite-plus/test" },
                server: { deps: { inline: ["@effect/vitest"] } },
            },
            config.test ?? {}
        ),
        lint: {
            ...config.lint,
            extends: [recommended, ...(config.lint?.extends ?? [])],
        },
    });
}
