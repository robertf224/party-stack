import { defineLibraryConfig } from "@party-stack/build-config";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineLibraryConfig({
    run: {
        tasks: {
            test: { command: "vp test --project unit" },
            "test:browser": { command: "vp test --project browser", dependsOn: ["build"] },
            "bench:browser": { command: "vp test bench --project browser", dependsOn: ["build"] },
        },
    },
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    include: ["src/**/*.test.{ts,tsx}"],
                    exclude: ["src/**/*.browser.test.ts"],
                },
            },
            {
                extends: false,
                test: {
                    name: "browser",
                    include: ["src/**/*.browser.test.ts"],
                    benchmark: { include: ["src/**/*.browser.bench.ts"] },
                    browser: {
                        enabled: true,
                        headless: true,
                        instances: [{ browser: "chromium" }],
                        provider: playwright(),
                    },
                },
            },
        ],
    },
});
