import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";
import type { Page } from "playwright";

type Fixture = {
    state(): {
        providerFallbacks: number;
        attachmentFallbacks: number;
        borrowedCloses: number;
        ownedOpened: number[];
        ownedClosed: number[];
        reads: { owner: string; aborted: boolean }[];
        created: string[];
        revoked: string[];
    };
    resolve(index: number): void;
    close(): void;
};
const state = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, "borrowedFixture") as Fixture).state());
const close = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, "borrowedFixture") as Fixture).close());
const resolve = (page: Page, index: number) =>
    page.evaluate((index) => (Reflect.get(window, "borrowedFixture") as Fixture).resolve(index), index);
async function withBorrowed(params: string, run: (page: Page) => Promise<void>) {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/borrowed-provider.browser.test",
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    const browser = await chromium.launch();
    try {
        await server.listen();
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.text().includes("uncached promise")) errors.push(message.text());
        });
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/borrowed-provider.html?${params}`);
        await run(page);
        expect(errors).toEqual([]);
    } finally {
        await browser.close();
        await server.close();
    }
}

test.each(["", "strict"])(
    "a preloaded borrowed view commits no provider fallback (%s)",
    async (mode) => {
        await withBorrowed(mode, async (page) => {
            await expect.poll(() => page.getByTestId("ready").textContent()).toBe("first: Preloaded");
            expect((await state(page)).providerFallbacks).toBe(0);
            expect((await state(page)).reads).toEqual([]);
            await page.getByRole("button", { name: "Replace view", exact: true }).click();
            await expect.poll(() => page.getByTestId("ready").textContent()).toBe("second: Preloaded");
            expect((await state(page)).providerFallbacks).toBe(0);
            await close(page);
            expect((await state(page)).borrowedCloses).toBe(0);
        });
    },
    30_000
);

test("StrictMode borrowed attachment ownership survives replay and closes on replacement/unmount", async () => {
    await withBorrowed("strict", async (page) => {
        await expect.poll(() => page.getByTestId("ready").textContent()).toBe("first: Preloaded");
        await page.getByRole("button", { name: "Read attachment", exact: true }).click();
        await expect
            .poll(async () => (await state(page)).reads)
            .toEqual([{ owner: "first", aborted: false }]);
        await resolve(page, 0);
        await expect.poll(() => page.getByTestId("url").textContent()).toMatch(/^blob:/);
        const first = (await state(page)).created[0]!;
        expect((await state(page)).revoked).toEqual([]);
        await page.getByRole("button", { name: "Replace view", exact: true }).click();
        await expect
            .poll(async () => (await state(page)).reads)
            .toEqual([
                { owner: "first", aborted: true },
                { owner: "second", aborted: false },
            ]);
        await expect.poll(async () => (await state(page)).revoked).toEqual([first]);
        await resolve(page, 1);
        await expect.poll(() => page.getByTestId("url").textContent()).toMatch(/^blob:/);
        await close(page);
        await expect.poll(async () => (await state(page)).reads.every((read) => read.aborted)).toBe(true);
        await expect.poll(async () => (await state(page)).revoked).toEqual((await state(page)).created);
        expect((await state(page)).providerFallbacks).toBe(0);
        expect((await state(page)).borrowedCloses).toBe(0);
    });
}, 30_000);

test("a borrowed owner cleans a suspended attachment read after a real unmount", async () => {
    await withBorrowed("strict", async (page) => {
        await expect.poll(() => page.getByTestId("ready").textContent()).toBe("first: Preloaded");
        await page.getByRole("button", { name: "Read attachment", exact: true }).click();
        await expect.poll(async () => (await state(page)).reads.length).toBe(1);
        await close(page);
        await expect.poll(async () => (await state(page)).reads[0]!.aborted).toBe(true);
        await resolve(page, 0);
        await expect.poll(async () => (await state(page)).created.length).toBe(1);
        await expect.poll(async () => (await state(page)).revoked).toEqual((await state(page)).created);
        expect((await state(page)).borrowedCloses).toBe(0);
    });
}, 30_000);

test("synchronous ownership allocates once through StrictMode and disposes each replacement", async () => {
    await withBorrowed("owned&strict", async (page) => {
        await expect.poll(() => page.getByTestId("value").textContent()).toBe("0");
        expect((await state(page)).ownedOpened).toEqual([0]);
        expect((await state(page)).ownedClosed).toEqual([]);
        expect((await state(page)).providerFallbacks).toBe(0);
        await page.getByRole("button", { name: "Replace value", exact: true }).click();
        await expect.poll(() => page.getByTestId("value").textContent()).toBe("1");
        await expect.poll(async () => (await state(page)).ownedClosed).toEqual([0]);
        await close(page);
        await expect.poll(async () => (await state(page)).ownedClosed).toEqual([0, 1]);
        expect((await state(page)).ownedOpened).toEqual([0, 1]);
    });
}, 30_000);

test("an abandoned synchronous-owner render never allocates a value", async () => {
    await withBorrowed("owned&strict&abandoned", async (page) => {
        await expect.poll(() => page.getByTestId("provider-pending").isVisible()).toBe(true);
        await close(page);
        expect((await state(page)).ownedOpened).toEqual([]);
        expect((await state(page)).ownedClosed).toEqual([]);
        expect((await state(page)).reads).toEqual([]);
    });
}, 30_000);
