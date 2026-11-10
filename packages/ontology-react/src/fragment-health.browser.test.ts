import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";

// Native include facades currently omit source-health dependencies. Keep the
// desired behavior executable until DB exposes and relays those dependencies.
test.fails("fragment health observes the existing include without acquiring another query", async () => {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/fragment-health.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/fragment-health.html`);
        await expect.poll(() => page.getByTestId("title").textContent()).toBe("One");
        const metrics = () =>
            page.evaluate(() => ({ ...Reflect.get(window, "fragmentHealthFixture").metrics }));
        const before = await metrics();
        await page.getByRole("button", { name: "Toggle health", exact: true }).click();
        await expect.poll(() => page.getByTestId("health").textContent()).toBe("healthy");
        expect(await metrics()).toEqual(before);
        await page.getByRole("button", { name: "Fail sync", exact: true }).click();
        expect(
            await page.evaluate(() => Reflect.get(window, "fragmentHealthFixture").sourceHealth().hasErrors)
        ).toBe(true);
        await expect.poll(() => page.getByTestId("health").textContent()).toBe("problem");
        expect(await page.getByTestId("title").textContent()).toBe("One");
        expect(await page.getByTestId("pending").count()).toBe(0);
        await page.getByRole("button", { name: "Recover sync", exact: true }).click();
        await expect.poll(() => page.getByTestId("health").textContent()).toBe("healthy");
        expect(await metrics()).toEqual(before);
        await page.evaluate(() => Reflect.get(window, "fragmentHealthFixture").close());
        expect(errors).toEqual([]);
    } finally {
        await browser.close();
        await server.close();
    }
}, 30_000);
