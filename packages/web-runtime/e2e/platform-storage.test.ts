import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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
}, 30_000);
afterAll(async () => {
    await browser?.close();
    await server?.close();
});

async function run(page: Page, method: string, ...args: unknown[]) {
    return page.evaluate(
        async ({ method, args }) => {
            const api = Reflect.get(window, "persistenceTest") as Record<
                string,
                (...args: unknown[]) => unknown
            >;
            return await api[method]!(...args);
        },
        { method, args }
    );
}
async function page(test: (page: Page) => Promise<void>) {
    const context = await browser.newContext();
    const current = await context.newPage();
    const errors: string[] = [];
    current.on("pageerror", (error) => errors.push(error.message));
    try {
        await current.goto(`${origin}e2e/tab.html?scope=${crypto.randomUUID()}`);
        await current.waitForFunction(() => Reflect.has(window, "persistenceTest"));
        await test(current);
        expect(errors).toEqual([]);
    } finally {
        await run(current, "cleanup");
        await context.close();
    }
}

describe("persistent platform storage with one designated owner", () => {
    it("streams unknown-length recordings to OPFS and removes partial writes", async () => {
        await page(async (current) => {
            expect(await run(current, "streamRecording")).toBe("Success");
            expect(await run(current, "recordingSize")).toBe(10 * 1024 * 1024);
            expect(await run(current, "streamRecording", true)).toBe("Failure");
            expect(await run(current, "recordingSize", true)).toBe(0);
        });
    });
    it("commits native tables and restores them after the owner closes and reopens", async () => {
        await page(async (current) => {
            const item = { id: "one", title: "Original", score: 1 };
            await run(current, "insert", item);
            expect(await run(current, "durable")).toMatchObject({ keys: ["one"] });
            await run(current, "update", "one", "Updated");
            await run(current, "cleanup");
            await current.reload();
            await current.waitForFunction(() => Reflect.has(window, "persistenceTest"));
            expect(await run(current, "rows")).toEqual([{ ...item, title: "Updated" }]);
            await run(current, "remove", "one");
            expect(await run(current, "rows")).toEqual([]);
        });
    });
});
