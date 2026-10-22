import { expect, it } from "vite-plus/test";
import { defineEffectLibraryConfig } from "./effect.js";
import { defineLibraryConfig } from "./index.js";

it("Effect test helpers share Vite+'s runner without changing base libraries", () => {
    const config = defineEffectLibraryConfig();
    expect(config.test?.alias).toEqual([{ find: /^vitest$/, replacement: "vite-plus/test" }]);
    // Worker pools need the real vitest/worker entry, not vite-plus/test/worker.
    expect(/^vitest$/.test("vitest/worker")).toBe(false);
    expect(config.test?.server?.deps?.inline).toContain("@effect/vitest");
    expect(defineLibraryConfig().test?.alias).toBeUndefined();
});

it("Effect test defaults preserve caller aliases and inlined dependencies", () => {
    const config = defineEffectLibraryConfig({
        test: { alias: { app: "/src" }, server: { deps: { inline: ["test-helper"] } } },
    });
    expect(config.test?.alias).toEqual(
        expect.arrayContaining([
            { find: /^vitest$/, replacement: "vite-plus/test" },
            { find: "app", replacement: "/src" },
        ])
    );
    expect(config.test?.server?.deps?.inline).toEqual(
        expect.arrayContaining(["@effect/vitest", "test-helper"])
    );
});
