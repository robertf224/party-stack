import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        benchmark: {
            include: ["src/**/*.browser.bench.ts"],
        },
        browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: "chromium" }],
            provider: "playwright",
        },
    },
});
