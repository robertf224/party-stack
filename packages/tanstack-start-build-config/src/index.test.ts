import { devtools } from "@tanstack/devtools-vite";
import { describe, expect, it, vi } from "vite-plus/test";
import { defineAppConfig } from "./index.js";

vi.mock("@tanstack/devtools-vite", async (importOriginal) => {
    const original = await importOriginal<typeof import("@tanstack/devtools-vite")>();
    return { ...original, devtools: vi.fn(original.devtools) };
});

describe("TanStack Start config", () => {
    it("preserves app tasks and caller plugins alongside the framework defaults", () => {
        const plugins = [{ name: "app-plugin" }];
        const config = defineAppConfig({
            plugins,
            server: { port: 3000 },
            build: { sourcemap: true },
            run: { tasks: { dev: { command: "vp dev --host" } } },
            start: { router: { routesDirectory: "src/pages" } },
        });

        expect(config.plugins?.[0]).toBe(plugins);
        expect(devtools).toHaveBeenCalledWith({ consolePiping: { enabled: false } });
        expect(config.server).toEqual({ port: 3000 });
        expect(config.build).toMatchObject({ sourcemap: true });
        expect(config.run?.tasks?.dev).toMatchObject({
            command: "vp dev --host",
            cache: false,
            dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
        });
        expect(config.run?.tasks?.build).toMatchObject({
            command: "vp build",
            dependsOn: expect.arrayContaining(["check"]),
        });
    });

    it("does not construct framework plugins during task metadata discovery", () => {
        vi.stubEnv("VP_RESOLVING_CONFIG_METADATA", "1");
        try {
            const config = defineAppConfig();
            expect(config.plugins).toBeUndefined();
            expect(config.run?.tasks?.test).toEqual({ command: "vp test", dependsOn: ["build"] });
        } finally {
            vi.unstubAllEnvs();
        }
    });
});
