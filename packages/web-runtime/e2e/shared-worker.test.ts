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
    let completed = false;
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
        // Inject the worker's observed network state explicitly. BrowserContext's
        // offline emulation changes pages but need not change SharedWorker flags.
        // The connectivity notification must wake its outbox, not the data poll.
        await context.setOffline(true);
        await run(second, "ownerNetwork", false);
        await run(second, "enqueue", "offline-action");
        await expect.poll(() => run(second, "rows")).toEqual([{ id: "one", count: 3 }]);
        expect(await run(second, "receipt", "offline-action")).toBeUndefined();
        await context.setOffline(false);
        await run(second, "ownerNetwork", true);
        await expect
            .poll(() => run(second, "receipt", "offline-action"))
            .toMatchObject({ outcome: "committed" });
        await second.reload();
        await second.waitForFunction(() => Reflect.has(window, "replicaTest"), null, { timeout: 20_000 });
        expect(await run(second, "sourceId")).toBe(sourceId);
        await expect.poll(() => run(second, "rows")).toEqual([{ id: "one", count: 3 }]);
        expect(errors).toEqual([]);
        completed = true;
    } finally {
        if (!completed && !second.isClosed())
            console.info(
                "Worker reconnect diagnostics",
                JSON.stringify(await run(second, "diagnostics", "offline-action"))
            );
        if (!second.isClosed()) await run(second, "cleanup").catch(() => undefined);
        await context.close();
    }
});

test("public SDK worker setup shares one owner and keeps another tab alive after cleanup", async () => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    const errors: string[] = [];
    const invoke = (page: Page, method: string) =>
        page.evaluate(async (method) => {
            const api = Reflect.get(window, "publicSetup") as Record<string, () => Promise<unknown>>;
            return api[method]!();
        }, method);
    let stage = "opening";
    let completed = false;
    try {
        for (const page of [first, second]) {
            page.on("pageerror", (error) => errors.push(error.message));
        }
        const url = `${origin}e2e/public-tab.html?scope=${crypto.randomUUID()}`;
        for (const page of [first, second]) {
            await page.goto(url);
            await page.waitForFunction(() => Reflect.has(window, "publicSetup"), null, { timeout: 10_000 });
        }
        stage = "first action";
        await invoke(first, "increment");
        await expect.poll(() => invoke(first, "outcome")).toBe("confirmed");
        await expect.poll(() => invoke(second, "rows")).toEqual([{ id: "one", count: 1 }]);
        stage = "closing first tab";
        await invoke(first, "cleanup");
        await first.close();
        stage = "second action";
        await invoke(second, "increment");
        await expect.poll(() => invoke(second, "outcome")).toBe("confirmed");
        await expect.poll(() => invoke(second, "rows")).toEqual([{ id: "one", count: 2 }]);
        stage = "closing second tab";
        await invoke(second, "cleanup");
        expect(errors).toEqual([]);
        completed = true;
    } finally {
        if (!completed) {
            console.info("Public setup failure", { stage, errors });
            for (const page of [first, second])
                if (!page.isClosed() && (await page.evaluate(() => Reflect.has(window, "publicSetup"))))
                    console.info("Replica diagnostics", await invoke(page, "diagnostics"));
        }
        await context.close();
    }
});
