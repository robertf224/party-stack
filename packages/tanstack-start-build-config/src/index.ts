import { defineAppConfig as defineBaseAppConfig, type AppConfig } from "@party-stack/build-config";
import { worktreeDev, type WorktreeDevOptions } from "@party-stack/vite-plugin-worktree-dev";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { lazyPlugins, type ViteUserConfig } from "vite-plus";

export type TanStackStartConfig = AppConfig & {
    start?: Parameters<typeof tanstackStart>[0];
    worktreeDev?: WorktreeDevOptions | false;
};

export function defineAppConfig(config: TanStackStartConfig = {}): ViteUserConfig {
    const { start, plugins, worktreeDev: worktreeDevOptions, ...appConfig } = config;
    return defineBaseAppConfig({
        ...appConfig,
        plugins: lazyPlugins(() => [
            plugins,
            worktreeDevOptions !== false && worktreeDev(worktreeDevOptions),
            // Vite+ already forwards browser logs; bidirectional piping would echo them back forever.
            devtools({ consolePiping: { enabled: false } }),
            tailwindcss(),
            tanstackStart(start),
            react(),
            babel({ presets: [reactCompilerPreset()] }),
        ]),
    });
}
