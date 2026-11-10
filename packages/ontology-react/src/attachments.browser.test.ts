import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "vite-plus/test";
import type { Page } from "playwright";

type Fixture = {
    state(): {
        reads: { aborted: boolean; source: { primaryKey: number } }[];
        revoked: string[];
        created: string[];
        fields: string[][];
        listeners: number;
        pinCommands: string[];
    };
    resolve(index: number): void;
    reject(index: number): void;
};
async function withAttachments(run: (page: Page) => Promise<void>) {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/attachments.browser.test",
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
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/attachments.html`);
        await run(page);
        expect(errors).toEqual([]);
    } finally {
        await browser.close();
        await server.close();
    }
}
const state = (page: Page) =>
    page.evaluate(() => (Reflect.get(window, "attachmentFixture") as Fixture).state());
const resolve = (page: Page, index: number) =>
    page.evaluate((index) => (Reflect.get(window, "attachmentFixture") as Fixture).resolve(index), index);

test("Suspense attachment hooks share reads through StrictMode and keep URLs until the view closes", async () => {
    await withAttachments(async (page) => {
        await expect.poll(async () => (await state(page)).reads.length).toBe(1);
        await expect.poll(() => page.getByTestId("pending-first").isVisible()).toBe(true);
        await resolve(page, 0);
        await expect.poll(() => page.getByTestId("url-first").textContent()).toMatch(/^blob:/);
        const url = await page.getByTestId("url-first").textContent();
        expect(await page.getByTestId("url-second").textContent()).toBe(url);
        expect(await page.getByTestId("metadata-first").textContent()).toBe("photo.png");
        expect((await state(page)).fields).toEqual([["name", "size"]]);
        expect((await state(page)).created).toEqual([url]);
        await page.getByRole("button", { name: "Second", exact: true }).click();
        expect((await state(page)).revoked).toEqual([]);
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        expect(await page.getByTestId("url-first").textContent()).toBe("");
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        expect(await page.getByTestId("url-first").textContent()).toBe(url);
        expect((await state(page)).reads).toHaveLength(1);
        await page.getByRole("button", { name: "Pin", exact: true }).click();
        await page.getByRole("button", { name: "Unpin", exact: true }).click();
        expect((await state(page)).pinCommands).toEqual(["set", "clear"]);
        await page.getByRole("button", { name: "Close view", exact: true }).click();
        await expect.poll(async () => (await state(page)).listeners).toBe(0);
        await expect.poll(async () => (await state(page)).revoked).toEqual([url]);
        expect((await state(page)).reads[0]!.aborted).toBe(true);
    });
}, 30_000);

test("disabled Suspense hooks accept toggles while pending and owner disposal cleans late URLs", async () => {
    await withAttachments(async (page) => {
        await expect.poll(async () => (await state(page)).reads.length).toBe(1);
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        expect(await page.getByTestId("url-first").textContent()).toBe("");
        expect((await state(page)).reads).toHaveLength(1);
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        await page.getByRole("button", { name: "Close view", exact: true }).click();
        await expect.poll(async () => (await state(page)).reads[0]!.aborted).toBe(true);
        await resolve(page, 0);
        await expect.poll(async () => (await state(page)).revoked.length).toBe(1);
        expect((await state(page)).created).toEqual((await state(page)).revoked);
    });
}, 30_000);

test("initial attachment failures reach an error boundary; resetting the view makes a fresh request", async () => {
    await withAttachments(async (page) => {
        await expect.poll(async () => (await state(page)).reads.length).toBe(1);
        await page.evaluate(() => (Reflect.get(window, "attachmentFixture") as Fixture).reject(0));
        await expect.poll(() => page.getByTestId("error").textContent()).toBe("Unavailable");
        await page.getByRole("button", { name: "Second", exact: true }).click();
        expect((await state(page)).reads).toHaveLength(1);
        await page.getByRole("button", { name: "Reset view", exact: true }).click();
        await expect.poll(async () => (await state(page)).reads.length).toBe(2);
        await resolve(page, 1);
        await expect.poll(() => page.getByTestId("url-first").textContent()).toMatch(/^blob:/);
        await page.getByRole("button", { name: "Source", exact: true }).click();
        await expect.poll(async () => (await state(page)).reads.length).toBe(3);
        expect((await state(page)).reads[2]!.source.primaryKey).toBe(2);
        await resolve(page, 2);
        await expect.poll(() => page.getByTestId("url-first").textContent()).toMatch(/^blob:/);
        await page.getByRole("button", { name: "Close view", exact: true }).click();
        await expect.poll(async () => (await state(page)).revoked.length).toBe(2);
    });
}, 30_000);

test("fragment components read native includes directly and detach without dependent-query errors", async () => {
    const server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        cacheDir: "node_modules/.vite/attachments.browser.test",
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
            if (message.type() === "error") errors.push(message.text());
            if (message.type() === "warning" && message.text().includes("Join requires an index"))
                errors.push(message.text());
        });
        await page.goto(`${server.resolvedUrls!.local[0]}e2e/fragments.html`);
        await expect.poll(() => page.getByTestId("title").textContent(), { timeout: 10_000 }).toBe("One");
        const renders = () =>
            page.evaluate(() => (Reflect.get(window, "fragmentFixture") as { renders(): number }).renders());
        const initial = await renders();
        await page.getByRole("button", { name: "Body", exact: true }).click();
        expect(await renders()).toBe(initial);
        await page.getByRole("button", { name: "Title", exact: true }).click();
        await expect.poll(() => page.getByTestId("title").textContent()).toBe("Updated");
        // Rebind arguments without changing the object or remounting the list.
        await page.getByRole("button", { name: "Arguments", exact: true }).click();
        await expect.poll(() => page.getByTestId("title").textContent()).toBe("Prefix: Updated");
        await page.getByRole("button", { name: "Arguments", exact: true }).click();
        await expect.poll(() => page.getByTestId("title").textContent()).toBe("Updated");
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        expect(await page.getByTestId("title").count()).toBe(0);
        await page.getByRole("button", { name: "Toggle", exact: true }).click();
        await expect.poll(() => page.getByTestId("title").textContent()).toBe("Updated");
        // Replace the parent query while its native fragment facades have mounted
        // subscribers. A fresh root must never inherit a retired include's data.
        for (let index = 0; index < 20; index++) {
            await page.getByRole("button", { name: "Switch", exact: true }).click();
            await expect
                .poll(() => page.getByTestId("title").textContent())
                .toBe(index % 2 === 0 ? "Two" : "Updated");
        }
        expect(errors).toEqual([]);
    } finally {
        await browser.close();
        await server.close();
    }
}, 30_000);
