import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

let server: ViteDevServer;
let browser: Browser;
let origin: string;
beforeAll(async () => {
    server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch();
}, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

async function run(page: Page, method: string, ...args: unknown[]) {
    return page.evaluate(async ({ method, args }) => {
        const api = Reflect.get(window, "persistenceTest") as Record<string, (...args: unknown[]) => unknown>;
        return await api[method]!(...args);
    }, { method, args });
}
async function tabs(test: (writer: Page, reader: Page) => Promise<void>, coordinator = "party") {
    const context = await browser.newContext();
    const writer = await context.newPage();
    const reader = await context.newPage();
    const errors: string[] = [];
    for (const page of [writer, reader]) page.on("pageerror", (error) => errors.push(error.message));
    const url = `${origin}e2e/tab.html?scope=${crypto.randomUUID()}&coordinator=${coordinator}`;
    try {
        await writer.goto(url);
        await writer.waitForFunction(() => Reflect.has(window, "persistenceTest"), null, { timeout: 10_000 });
        await reader.goto(url);
        await reader.waitForFunction(() => Reflect.has(window, "persistenceTest"), null, { timeout: 10_000 });
        await test(writer, reader);
        expect(errors).toEqual([]);
    } finally {
        await Promise.allSettled([writer, reader].map((page) => run(page, "cleanup")));
        await context.close();
    }
}
const one = { id: "one", title: "Original", score: 1 };
describe("real IndexedDB / Web Locks / BroadcastChannel tabs", () => {
    it("propagates insert, update, delete, and follower writes to live queries", async () => {
        await tabs(async (writer, reader) => {
            await run(writer, "insert", one);
            await expect.poll(() => run(reader, "rows")).toEqual([one]);
            await run(reader, "update", "one", "From follower");
            await expect.poll(() => run(writer, "rows")).toEqual([{ ...one, title: "From follower" }]);
            await run(writer, "remove", "one");
            await expect.poll(() => run(reader, "rows")).toEqual([]);
        });
    });
    it("recovers a missed middle commit when a later sequence arrives", async () => {
        await tabs(async (writer, reader) => {
            await run(writer, "insert", one);
            await expect.poll(() => run(reader, "rows")).toEqual([one]);
            await run(reader, "drop", true);
            await run(writer, "update", "one", "Missed");
            expect(await run(reader, "rows")).toEqual([one]);
            await run(reader, "drop", false);
            const two = { id: "two", title: "Next", score: 2 };
            await run(writer, "insert", two);
            await expect.poll(() => run(reader, "rows")).toEqual([{ ...one, title: "Missed" }, two]);
        });
    });
    it("recovers a missed final update on resume without another write", async () => {
        await tabs(async (writer, reader) => {
            await run(writer, "insert", one);
            await expect.poll(() => run(reader, "rows")).toEqual([one]);
            await run(reader, "drop", true);
            await run(writer, "update", "one", "Final");
            expect(await run(reader, "rows")).toEqual([one]);
            await run(reader, "drop", false);
            await run(reader, "resume");
            await expect.poll(() => run(reader, "rows")).toEqual([{ ...one, title: "Final" }]);
        });
    });
    it("elects a replacement leader and continues persisting after its tab closes", async () => {
        await tabs(async (writer, reader) => {
            expect(await run(writer, "leader")).toBe(true);
            await run(writer, "insert", one);
            await expect.poll(() => run(reader, "rows")).toEqual([one]);
            await writer.close();
            await expect.poll(() => run(reader, "leader")).toBe(true);
            await run(reader, "update", "one", "After failover");
            expect(await run(reader, "rows")).toEqual([{ ...one, title: "After failover" }]);
        });
    });
    it("recovers a missed first commit and deletion on return to visibility", async () => {
        await tabs(async (writer, reader) => {
            await run(reader, "drop", true);
            await run(writer, "insert", one);
            expect(await run(reader, "rows")).toEqual([]);
            await run(reader, "drop", false);
            await reader.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await expect.poll(() => run(reader, "rows")).toEqual([one]);
            await run(reader, "drop", true);
            await run(writer, "remove", "one");
            expect(await run(reader, "rows")).toEqual([one]);
            await run(reader, "drop", false);
            await run(reader, "resume");
            await expect.poll(() => run(reader, "rows")).toEqual([]);
        });
    });
    it("keeps simultaneous writes from both tabs and reloads durable state", async () => {
        await tabs(async (writer, reader) => {
            const items = Array.from({ length: 20 }, (_, score) => ({ id: String(score), title: `Task ${score}`, score }));
            await Promise.all(items.map((item, index) => run(index % 2 ? reader : writer, "insert", item)));
            expect(await run(writer, "durable")).toMatchObject({ position: { latestSeq: 20, latestRowVersion: 20 }, keys: expect.arrayContaining(items.map((item) => item.id)) });
            await expect.poll(() => run(reader, "rows")).toEqual(items);
            await expect.poll(() => run(writer, "rows")).toEqual(items);
            await reader.reload();
            await reader.waitForFunction(() => Reflect.has(window, "persistenceTest"), null, { timeout: 10_000 });
            expect(await run(reader, "rows")).toEqual(items);
        });
    });
    it("catches up after Chromium freezes and resumes the reader page", async () => {
        await tabs(async (writer, reader) => {
            await run(writer, "insert", one);
            await expect.poll(() => run(reader, "rows")).toEqual([one]);
            const session = await reader.context().newCDPSession(reader);
            try {
                await session.send("Page.setWebLifecycleState", { state: "frozen" });
                await run(writer, "update", "one", "While frozen");
                await session.send("Page.setWebLifecycleState", { state: "active" });
                await expect.poll(() => run(reader, "rows")).toEqual([{ ...one, title: "While frozen" }]);
            } finally {
                await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
                await session.detach();
            }
        });
    });

    it.fails("upstream reference: local acknowledgements can skip concurrent remote commits", async () => {
        await tabs(async (writer, reader) => {
            const items = Array.from({ length: 20 }, (_, score) => ({ id: String(score), title: `Task ${score}`, score }));
            await Promise.all(items.map((item, index) => run(index % 2 ? reader : writer, "insert", item)));
            expect(await run(writer, "durable")).toMatchObject({ position: { latestSeq: 20, latestRowVersion: 20 }, keys: expect.arrayContaining(items.map((item) => item.id)) });
            await expect.poll(() => run(reader, "rows"), { timeout: 1000 }).toEqual(items);
        }, "upstream");
    });

});
