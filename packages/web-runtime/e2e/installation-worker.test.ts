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
            const api = Reflect.get(window, "installationTest") as Record<
                string,
                (...args: unknown[]) => unknown
            >;
            return await api[method]!(...args);
        },
        { method, args }
    );

test("one installation worker owns credentials and multiple ontologies for memory-only tabs", async () => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    const errors: string[] = [];
    for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message));
    const url = `${origin}e2e/installation-tab.html?scope=${crypto.randomUUID()}`;
    try {
        for (const page of [first, second]) {
            await page.goto(url);
            await page.waitForFunction(() => Reflect.has(window, "installationTest"), null, {
                timeout: 20_000,
            });
        }
        expect(await run(first, "connections")).toEqual([]);
        expect(await run(second, "connections")).toEqual([]);
        expect(await run(first, "rejectedPrototypeCall")).toBe("InvalidRequest");
        await run(first, "signIn", "alice");
        await expect
            .poll(() => run(second, "connections"))
            .toMatchObject([{ userId: "alice", state: { status: "active" } }]);
        for (const page of [first, second]) {
            expect(await run(page, "rows", "first-ontology")).toEqual([]);
            expect(await run(page, "rows", "second-ontology")).toEqual([]);
        }
        await run(first, "increment", "first-ontology");
        for (const page of [first, second]) {
            await expect
                .poll(() => run(page, "rows", "first-ontology"))
                .toMatchObject([{ id: "one", count: 1 }]);
            expect(await run(page, "rows", "second-ontology")).toEqual([]);
        }
        await first.reload();
        await first.waitForFunction(() => Reflect.has(window, "installationTest"), null, { timeout: 20_000 });
        expect(await run(first, "connections")).toMatchObject([
            { userId: "alice", state: { status: "active" } },
        ]);
        await run(second, "disconnect");
        await expect
            .poll(() => run(first, "connections"))
            .toMatchObject([{ userId: "alice", state: { status: "inactive" } }]);
        await run(first, "signIn", "alice");
        await expect
            .poll(() => run(second, "connections"))
            .toMatchObject([{ userId: "alice", state: { status: "active" } }]);
        await expect
            .poll(() => run(first, "rows", "first-ontology"))
            .toMatchObject([{ id: "one", count: 1 }]);
        expect(errors).toEqual([]);
    } finally {
        await Promise.allSettled([first, second].map((page) => run(page, "cleanup")));
        await context.close();
    }
});

test("installation startup failures reach the client without hanging worker acquisition", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(`${origin}e2e/installation-tab.html?scope=fail:${crypto.randomUUID()}`);
        await page.waitForFunction(() => Reflect.has(window, "installationFailure"), null, {
            timeout: 5_000,
        });
        expect(
            await page.evaluate(() => {
                const error = Reflect.get(window, "installationFailure") as {
                    _tag: string;
                    kind: string;
                    message: string;
                };
                return { _tag: error._tag, kind: error.kind, message: error.message };
            })
        ).toEqual({
            _tag: "BackendError",
            kind: "InvalidConfiguration",
            message: "Deliberate startup failure.",
        });
    } finally {
        await context.close();
    }
});
