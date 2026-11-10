import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";

type Fixture = {
    records: { id: string; present: boolean; fallback?: number; commit?: number }[];
    metrics: { loads: number; releases: number };
    release(): void;
    close(): Promise<void>;
};

test.each([
    "client",
    "ondemand",
    "ondemand&strict",
    "ondemand&async",
    "ondemand&retain",
    "native",
    "ondemand&strict&async",
    "native&strict",
])(
    "Suspense queries preserve readiness, focus and explicit retention (%s)",
    async (mode) => {
        const server = await createServer({
            root: fileURLToPath(new URL("../", import.meta.url)),
            cacheDir: "node_modules/.vite/readiness.browser.test",
            server: { host: "127.0.0.1", port: 0 },
            logLevel: "error",
            plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
        });
        const browser = await chromium.launch();
        try {
            await server.listen();
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${server.resolvedUrls!.local[0]}e2e/ready-latency.html?${mode}`);
            for (let i = 0; i < 5; i++) {
                await page.getByRole("button", { name: "Select cached row" }).click();
                if (mode.includes("async") && i === 0) {
                    await page.getByTestId("detail-pending").waitFor();
                    await page.evaluate(() => (Reflect.get(window, "fixture") as Fixture).release());
                }
                const title = page.getByRole("textbox", { name: "Item title" });
                await expect
                    .poll(() => title.inputValue())
                    .toBe(`Item ${i + (mode.startsWith("native") ? 20 : 0)}`);
                expect(await title.evaluate((input) => input === document.activeElement)).toBe(true);
            }
            const records = await page.evaluate(() => (Reflect.get(window, "fixture") as Fixture).records);
            expect(records).toHaveLength(5);
            if (mode.includes("async")) {
                expect(records[0]!.fallback).toBeDefined();
                expect(records.slice(1).every((record) => record.fallback === undefined)).toBe(true);
            } else {
                const ready = records.filter((record) => record.present);
                expect(ready.length).toBeGreaterThan(0);
                expect(ready.every((record) => record.fallback === undefined)).toBe(true);
            }
            expect(records.every((record) => record.commit !== undefined)).toBe(true);
            if (mode.startsWith("ondemand")) {
                // The fixture explicitly sets gcTime:1 for these modes, so only
                // inventory and current detail retain demand after navigation.
                // Retain mode chooses 60s instead. These are explicit policies,
                // not assumptions about TanStack's native default lifetime.
                // StrictMode's uncommitted candidates retain initial retry grace.
                await expect
                    .poll(
                        () =>
                            page.evaluate(() => {
                                const { loads, releases } = (Reflect.get(window, "fixture") as Fixture)
                                    .metrics;
                                return loads - releases;
                            }),
                        { timeout: mode.includes("strict") ? 7500 : 2000 }
                    )
                    .toBe(mode.includes("retain") ? 6 : 2);
            }
            await page.evaluate(() => (Reflect.get(window, "fixture") as Fixture).close());
            if (mode.startsWith("ondemand")) {
                await expect
                    .poll(() =>
                        page.evaluate(() => {
                            const { loads, releases } = (Reflect.get(window, "fixture") as Fixture).metrics;
                            return loads - releases;
                        })
                    )
                    .toBe(0);
            }
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
            await server.close();
        }
    },
    30_000
);
