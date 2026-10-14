import { defineConfig } from "vite-plus";
import type { ViteUserConfig } from "vite-plus";

type RunConfig = NonNullable<ViteUserConfig["run"]>;
type TaskDefinition = NonNullable<RunConfig["tasks"]>[string];
type TaskOptions = Exclude<TaskDefinition, string | string[]>;

/** Override individual task options without repeating their command or prerequisites. */
export type LibraryConfig = Omit<ViteUserConfig, "run"> & {
    run?: Omit<RunConfig, "tasks"> & {
        tasks?: Record<string, string | string[] | Partial<TaskOptions>>;
    };
};

/**
 * Configure an ESM library. Package overrides replace arrays and merge the
 * pack, test, and individual task options with these defaults.
 */
export function defineLibraryConfig(config: LibraryConfig = {}): ViteUserConfig {
    const base = defineConfig({
        resolve: { tsconfigPaths: true },
        run: {
            tasks: {
                check: {
                    command: "vp check",
                    // Track root files without making generated directory entries inputs.
                    cache: {
                        input: [{ auto: true }, "!.", "*.{json,jsonc,ts,mts,js,mjs}"],
                    },
                    dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
                },
                build: {
                    command: "vp pack",
                    // Generated outputs and package directory listings must not invalidate their own build.
                    cache: {
                        input: [{ auto: true }, "!.", "*.{json,jsonc,ts,mts,js,mjs}", "!lib/**"],
                    },
                    dependsOn: ["check", { task: "build", from: ["dependencies", "devDependencies"] }],
                },
                test: { command: "vp test", dependsOn: ["build"] },
            },
        },
        pack: {
            entry: [
                "src/**/*.{ts,tsx}",
                "!src/**/*.d.ts",
                "!src/**/*.test.{ts,tsx}",
                "!src/**/*.bench.{ts,tsx}",
            ],
            outDir: "lib",
            root: "src",
            target: "es2022",
            unbundle: true,
            fixedExtension: false,
            deps: { neverBundle: true },
        },
        test: { include: ["src/**/*.test.{ts,tsx}"], passWithNoTests: true },
    });
    return composeConfig(base, config);
}

export type AppConfig = LibraryConfig;

/** Configure app tasks while leaving framework plugins with the caller. */
export function defineAppConfig(config: AppConfig = {}): ViteUserConfig {
    return composeConfig(
        defineConfig({
            resolve: { tsconfigPaths: true },
            run: {
                tasks: {
                    check: {
                        command: "vp check",
                        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
                    },
                    build: {
                        command: "vp build",
                        // Shell nesting changed cache fingerprints without changing app outputs.
                        cache: { untrackedEnv: ["SHLVL"] },
                        dependsOn: ["check", { task: "build", from: ["dependencies", "devDependencies"] }],
                    },
                    test: { command: "vp test", dependsOn: ["build"] },
                    dev: {
                        command: "vp dev",
                        dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
                        cache: false,
                    },
                },
            },
            // Preserve Vite 7 browser support after the Vite 8 default target change.
            build: { target: ["chrome107", "edge107", "firefox104", "safari16"] },
            test: { include: ["src/**/*.test.{ts,tsx}"], passWithNoTests: true },
        }),
        config
    );
}

function composeConfig(base: ViteUserConfig, config: LibraryConfig): ViteUserConfig {
    const tasks = { ...base.run?.tasks };
    for (const [name, override] of Object.entries(config.run?.tasks ?? {})) {
        const original = tasks[name];
        if (typeof override === "string" || Array.isArray(override)) {
            tasks[name] = override;
        } else {
            const inherited = typeof original === "object" && !Array.isArray(original) ? original : undefined;
            const command = override.command ?? inherited?.command;
            if (command === undefined) {
                throw new Error(`Task "${name}" needs a command because it has no preset default.`);
            }
            tasks[name] = { ...inherited, ...override, command };
        }
    }
    return {
        ...base,
        ...config,
        resolve: { ...base.resolve, ...config.resolve },
        ...(base.pack || config.pack
            ? {
                  pack: Array.isArray(config.pack)
                      ? config.pack
                      : { ...(Array.isArray(base.pack) ? {} : base.pack), ...config.pack },
              }
            : {}),
        ...(base.build || config.build ? { build: { ...base.build, ...config.build } } : {}),
        test: { ...base.test, ...config.test },
        run: { ...base.run, ...config.run, tasks },
    };
}
