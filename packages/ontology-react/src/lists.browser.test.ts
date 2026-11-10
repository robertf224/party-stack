import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";

test.each(["root", "root-client", "included", "included-client", "included-held"])(
    "list readers suspend initially and grow a %s window",
    async (mode) => {
        const server = await createServer({
            root: fileURLToPath(new URL("../", import.meta.url)),
            cacheDir: "node_modules/.vite/lists.browser.test",
            server: { host: "127.0.0.1", port: 0 },
            logLevel: "error",
        });
        const browser = await chromium.launch();
        try {
            await server.listen();
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${server.resolvedUrls!.local[0]}e2e/lists.html?${mode}`);
            await page.getByTestId("pending").waitFor();
            await page.evaluate(() => (Reflect.get(window, "listFixture") as { release(): void }).release());
            await expect.poll(() => page.getByTestId("rows").textContent()).toBe("Item 1,Item 2");
            const metrics = () =>
                page.evaluate(() =>
                    (
                        Reflect.get(window, "listFixture") as {
                            metrics(): {
                                parentBuilds: number;
                                fallbackMounts: number;
                                orderedPending: boolean;
                                readers?: number;
                            };
                        }
                    ).metrics()
                );
            if (mode === "included-held") {
                await expect.poll(async () => (await metrics()).orderedPending).toBe(true);
                expect(await page.getByTestId("pending").count()).toBe(0);
                expect(await page.getByRole("button", { name: "More", exact: true }).isDisabled()).toBe(true);
                await page.evaluate(() =>
                    (Reflect.get(window, "listFixture") as { releaseOrdered(): void }).releaseOrdered()
                );
                await expect
                    .poll(async () => page.getByRole("button", { name: "More", exact: true }).isDisabled())
                    .toBe(false);
            }
            const before = await metrics();
            const collection = await page.getByTestId("collection").textContent();
            await page.getByRole("button", { name: "More" }).click();
            await expect
                .poll(() => page.getByTestId("rows").textContent())
                .toBe("Item 1,Item 2,Item 3,Item 4");
            expect(await page.getByTestId("pending").count()).toBe(0);
            expect(await page.getByTestId("collection").textContent()).toBe(collection);
            await page.getByRole("button", { name: "More" }).click();
            await expect
                .poll(() => page.getByTestId("rows").textContent())
                .toBe("Item 1,Item 2,Item 3,Item 4,Item 5");
            expect(await page.getByRole("button", { name: "More" }).isDisabled()).toBe(true);
            expect(await metrics()).toMatchObject({
                parentBuilds: before.parentBuilds,
                fallbackMounts: before.fallbackMounts,
            });
            if (mode.startsWith("included")) {
                await page.getByRole("button", { name: "Filter", exact: true }).click();
                await expect.poll(() => page.getByTestId("rows").textContent()).toBe("Item 3,Item 4");
                await page.getByRole("button", { name: "More", exact: true }).click();
                await expect.poll(() => page.getByTestId("rows").textContent()).toBe("Item 3,Item 4,Item 5");
                await page.getByRole("button", { name: "Toggle", exact: true }).click();
                await expect.poll(async () => (await metrics()).readers).toBe(0);
            }
            expect(errors).toEqual([]);
        } finally {
            await browser.close();
            await server.close();
        }
    },
    30_000
);
