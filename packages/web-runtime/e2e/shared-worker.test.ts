import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
beforeAll(async () => {
    server = await createServer({
        root: fileURLToPath(new URL("../", import.meta.url)),
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "error",
    });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch();
});
afterAll(async () => {
    await browser?.close();
    await server?.close();
});
const run = (page: Page, method: string, ...args: unknown[]) =>
    page.evaluate(
        async ({ method, args }) => {
            const api = Reflect.get(window, "replicaTest") as Record<string, (...args: unknown[]) => unknown>;
            return await api[method]!(...args);
        },
        { method, args }
    );

test("a SharedWorker owns persisted state while memory tabs and TanStack collections reconnect independently", async () => {
    // Non-persistent contexts exercise Chromium's isolated/private storage partition.
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    const errors: string[] = [];
    for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message));
    const url = `${origin}e2e/replica-tab.html?scope=${crypto.randomUUID()}`;
    try {
        for (const page of [first, second]) {
            await page.goto(url);
            await page.waitForFunction(() => Reflect.has(window, "replicaTest"), null, { timeout: 20_000 });
        }
        const sourceId = await run(first, "sourceId");
        expect(await run(second, "sourceId")).toBe(sourceId);
        await run(first, "enqueue", "first-action");
        for (const page of [first, second])
            await expect.poll(() => run(page, "rows")).toEqual([{ id: "one", count: 1 }]);
        await expect
            .poll(() => run(first, "receipt", "first-action"))
            .toMatchObject({ outcome: "committed" });
        await first.close();
        await run(second, "enqueue", "second-action");
        await expect.poll(() => run(second, "rows")).toEqual([{ id: "one", count: 2 }]);
        await expect
            .poll(() => run(second, "receipt", "second-action"))
            .toMatchObject({ outcome: "committed" });
        await second.reload();
        await second.waitForFunction(() => Reflect.has(window, "replicaTest"), null, { timeout: 20_000 });
        expect(await run(second, "sourceId")).toBe(sourceId);
        await expect.poll(() => run(second, "rows")).toEqual([{ id: "one", count: 2 }]);
        expect(errors).toEqual([]);
    } finally {
        if (!second.isClosed()) await run(second, "cleanup").catch(() => undefined);
        await context.close();
    }
});
