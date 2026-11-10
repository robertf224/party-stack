import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineEffectLibraryConfig({
    pack: { entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.bench.ts", "!src/contracts/**"] },
    run: {
        tasks: {
            test: { command: "vp test --project unit" },
            "bench:browser": { command: "vp test bench --project browser", dependsOn: ["build"] },
            "test:browser": { command: "vp test --project browser", dependsOn: ["build"] },
        },
    },
    test: {
        projects: [
            { test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.browser.test.ts"] } },
            {
                extends: false,
                test: {
                    name: "browser",
                    include: ["src/**/*.browser.test.ts"],
                    benchmark: { include: ["src/**/*.browser.bench.ts"] },
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: playwright(),
                        instances: [{ browser: "chromium" }],
                    },
                },
            },
        ],
    },
});
