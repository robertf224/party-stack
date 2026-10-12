import { defineAppConfig as defineBaseAppConfig, type AppConfig } from "@party-stack/build-config";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { lazyPlugins, type ViteUserConfig } from "vite-plus";

export type TanStackStartConfig = AppConfig & {
    start?: Parameters<typeof tanstackStart>[0];
};

export function defineAppConfig(config: TanStackStartConfig = {}): ViteUserConfig {
    const { start, plugins, ...appConfig } = config;
    return defineBaseAppConfig({
        ...appConfig,
        resolve: { tsconfigPaths: true, ...appConfig.resolve },
        plugins: lazyPlugins(() => [
            plugins,
            // Vite+ already forwards browser logs; bidirectional piping would echo them back forever.
            devtools({ consolePiping: { enabled: false } }),
            tailwindcss(),
            tanstackStart(start),
            react({
                babel: {
                    // Resolve the compiler from this package, including with pnpm's isolated dependencies.
                    cwd: import.meta.dirname,
                    plugins: ["babel-plugin-react-compiler"],
                },
            }),
        ]),
    });
}
