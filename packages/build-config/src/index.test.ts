import { describe, expect, it } from "vite-plus/test";
import { defineAppConfig, defineLibraryConfig } from "./index.js";

describe.each([
    ["library", defineLibraryConfig],
    ["app", defineAppConfig],
] as const)("%s resolution defaults", (_name, defineConfig) => {
    it("enables tsconfig paths by default", () => {
        expect(defineConfig().resolve?.tsconfigPaths).toBe(true);
    });

    it("preserves tsconfig paths with caller aliases", () => {
        const alias = { "@app": "/src" };
        expect(defineConfig({ resolve: { alias } }).resolve).toEqual({ tsconfigPaths: true, alias });
    });

    it("allows callers to disable tsconfig paths", () => {
        expect(defineConfig({ resolve: { tsconfigPaths: false } }).resolve?.tsconfigPaths).toBe(false);
        expect(defineConfig().resolve?.tsconfigPaths).toBe(true);
    });

    it("preserves Vite+ cache integration when callers supply plugins", () => {
        const plugin = { name: "caller-plugin" };
        const config = defineConfig({ plugins: [plugin] });
        expect(config.plugins).toContain(plugin);
        expect(config.plugins).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "vite-plus:vitest-cache-paths",
                    configureVitest: expect.any(Function),
                }),
            ])
        );
    });
});

describe("library config composition", () => {
    it("keeps prerequisites and packaging when a package overrides its commands", () => {
        const config = defineLibraryConfig({
            run: {
                tasks: {
                    check: { command: "vp check && tsc -p tsconfig.test.json" },
                    build: { command: "vp pack && vp run build:css" },
                },
            },
            pack: { deps: { neverBundle: [/\.css$/] } },
            test: { include: ["test/**/*.test.ts"], clearMocks: false },
        });
        expect(config.run?.tasks?.build).toMatchObject({
            command: "vp pack && vp run build:css",
            dependsOn: ["check", { task: "build", from: ["dependencies", "devDependencies"] }],
            cache: { input: expect.arrayContaining([{ auto: true }, "!lib/**"]) },
        });
        expect(config.run?.tasks?.check).toMatchObject({
            dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        });
        expect(config.pack).toMatchObject({ root: "src", outDir: "lib", deps: { neverBundle: [/\.css$/] } });
        expect(config.test).toMatchObject({ include: ["test/**/*.test.ts"], clearMocks: false });
    });

    it("supports build-only terminal tests without leaking overrides to another package", () => {
        const noTests = defineLibraryConfig({ run: { tasks: { test: { command: [] } } } });
        expect(noTests.run?.tasks?.test).toMatchObject({ command: [], dependsOn: ["build"] });
        expect(defineLibraryConfig().run?.tasks?.test).toMatchObject({
            command: "vp test",
            dependsOn: ["build"],
        });
    });

    it("requires a command for a new task", () => {
        expect(() => defineLibraryConfig({ run: { tasks: { codegen: { dependsOn: ["build"] } } } })).toThrow(
            'Task "codegen" needs a command'
        );
    });
});

describe("app config composition", () => {
    it("keeps app prerequisites and browser targets with caller plugins and build options", () => {
        const plugin = { name: "caller-framework" };
        const config = defineAppConfig({
            plugins: [plugin],
            build: { sourcemap: true },
            run: { tasks: { dev: { command: "vp dev --host" } } },
        });
        expect(config.plugins).toContain(plugin);
        expect(config.pack).toBeUndefined();
        expect(config.build).toMatchObject({
            target: ["chrome107", "edge107", "firefox104", "safari16"],
            sourcemap: true,
        });
        expect(config.run?.tasks?.dev).toEqual({
            command: "vp dev --host",
            cache: false,
            dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        });
        expect(config.run?.tasks?.test).toMatchObject({ command: "vp test", dependsOn: ["build"] });
    });
});
