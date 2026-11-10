import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";

test.each(["cold", "hydrate", "fail", "fail-short-retention", "fail-unbounded"])(
    "query hook preserves cold startup, hydration and errors (%s)",
    async (mode) => {
        const server = await createServer({
            root: fileURLToPath(new URL("../", import.meta.url)),
            cacheDir: "node_modules/.vite/query-lifecycle.browser.test",
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
            if (mode === "hydrate") {
                const module = await server.ssrLoadModule("/e2e/query-lifecycle.tsx");
                const initial = await module.serverFixture();
                await page.addInitScript((initial) => Reflect.set(window, "queryInitial", initial), initial);
            }
            await page.goto(`${server.resolvedUrls!.local[0]}e2e/query-lifecycle.html?${mode}`);
            if (mode.startsWith("fail")) {
                await expect
                    .poll(() => page.getByTestId("error").textContent())
                    .toContain("Fixture access denied")
                    .catch(async (error) => {
                        console.log(
                            "Query error fixture",
                            await page.locator("body").innerText(),
                            errors,
                            await page.evaluate(() => Reflect.get(window, "queryFixture").snapshot())
                        );
                        throw error;
                    });
                const snapshot = await page.evaluate(() => Reflect.get(window, "queryFixture").snapshot());
                expect(snapshot.metrics.loads).toBe(1);
            } else {
                await expect.poll(() => page.getByTestId("title").textContent()).toBe("First");
                await page.evaluate(() => Reflect.get(window, "queryFixture").publish("Changed"));
                await expect.poll(() => page.getByTestId("title").textContent()).toBe("Changed");
                await page.getByRole("button", { name: "Select other" }).click();
                await expect.poll(() => page.getByTestId("title").textContent()).toBe("Second");
                expect(await page.evaluate(() => Reflect.get(window, "queryFixture").errors)).toEqual([]);
            }
            await page.evaluate(() => Reflect.get(window, "queryFixture").close());
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
            await server.close();
        }
    },
    30_000
);
