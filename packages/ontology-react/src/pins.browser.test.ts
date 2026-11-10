import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";

test("pin controls follow ordered status notifications, not command completion or retired subscriptions", async () => {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/pins.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/pins.html`);
        const toggle = page.getByRole("checkbox", { name: "Download", exact: true });
        const state = () =>
            page.evaluate(() =>
                (
                    Reflect.get(window, "pinFixture") as {
                        state(): { commands: string[]; queued: number; retired: number };
                    }
                ).state()
            );
        const deliver = () =>
            page.evaluate(() => (Reflect.get(window, "pinFixture") as { deliver(): void }).deliver());
        await expect.poll(() => toggle.isEnabled()).toBe(true);
        await toggle.click();
        await expect.poll(async () => (await state()).commands).toEqual(["set"]);
        // The command has resolved, but its notification is deliberately held.
        expect(await toggle.isChecked()).toBe(false);
        await deliver();
        await expect.poll(() => toggle.isChecked()).toBe(true);
        await toggle.click();
        await expect.poll(async () => (await state()).commands).toEqual(["set", "clear"]);
        expect(await toggle.isChecked()).toBe(true);
        await deliver();
        await expect.poll(() => toggle.isChecked()).toBe(false);
        expect((await state()).retired).toBeGreaterThan(0);
        // Transport cancellation is asynchronous; an already queued callback
        // from StrictMode's disposed subscription cannot restore older status.
        await page.evaluate(() =>
            (Reflect.get(window, "pinFixture") as { deliverObsolete(): void }).deliverObsolete()
        );
        expect(await page.getByRole("status").textContent()).toBe("Off");
        expect(await toggle.isChecked()).toBe(false);
    } finally {
        await browser.close();
        await server.close();
    }
}, 30_000);
