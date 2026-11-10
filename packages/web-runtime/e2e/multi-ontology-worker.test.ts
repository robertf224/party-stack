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
            const api = Reflect.get(window, "serverTest") as Record<string, (...args: unknown[]) => unknown>;
            try {
                return await api[method]!(...args);
            } catch (cause) {
                const error = cause as {
                    kind?: string;
                    operation?: string;
                    message?: string;
                    cause?: unknown;
                };
                throw new Error(
                    `${method}: ${JSON.stringify({ kind: error.kind, operation: error.operation, message: error.message, cause: error.cause })}`
                );
            }
        },
        { method, args }
    );

test.each([1, 2, 3])(
    "one ontology server owns credentials and multiple ontologies for memory-only tabs (run %s)",
    async () => {
        const context = await browser.newContext();
        const first = await context.newPage();
        const second = await context.newPage();
        const errors: string[] = [];
        for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message));
        const url = `${origin}e2e/multi-ontology-tab.html?scope=${crypto.randomUUID()}`;
        try {
            for (const page of [first, second]) {
                await page.goto(url);
                await page.waitForFunction(() => Reflect.has(window, "serverTest"), null, {
                    timeout: 20_000,
                });
            }
            expect(await run(first, "connections")).toEqual([]);
            expect(await run(second, "connections")).toEqual([]);
            expect(await run(first, "rejectedUnknownAction")).toBe("NotFound");
            await run(first, "signIn", "alice");
            await expect
                .poll(() => run(second, "connections"))
                .toMatchObject([{ userId: "alice", state: { status: "active" } }]);
            for (const page of [first, second]) {
                expect(await run(page, "rows", "first-ontology")).toEqual([]);
                expect(await run(page, "rows", "second-ontology")).toEqual([]);
            }
            for (const page of [first, second]) await run(page, "startTracing", "first-ontology");
            await run(first, "increment", "first-ontology");
            for (const page of [first, second]) {
                await expect
                    .poll(async () => ((await run(page, "traces", "first-ontology")) as unknown[]).length)
                    .toBeGreaterThan(0);
            }
            expect(await run(first, "clearTraces", "first-ontology")).toEqual([]);
            expect(((await run(second, "traces", "first-ontology")) as unknown[]).length).toBeGreaterThan(0);
            for (const page of [first, second]) {
                await expect
                    .poll(() => run(page, "rows", "first-ontology"))
                    .toMatchObject([{ id: "one", count: 1 }]);
                expect(await run(page, "rows", "second-ontology")).toEqual([]);
            }
            const uploaded = await run(first, "upload");
            expect(await run(second, "download", uploaded)).toEqual({
                size: 3 * 64 * 1024 + 7,
                first: 7,
                last: 7,
            });
            await run(second, "watchPin", "first-ontology");
            await expect
                .poll(() => run(second, "pinEvents", "first-ontology"))
                .toMatchObject({ values: [undefined], errors: [] });
            await run(first, "setPin", "first-ontology");
            await expect
                .poll(async () =>
                    ((await run(second, "pinEvents", "first-ontology")) as { values: unknown[] }).values.at(
                        -1
                    )
                )
                .toMatchObject({ ready: true });
            await expect
                .poll(() => run(second, "pin", "first-ontology"))
                .toMatchObject({
                    device: { ready: true, attachments: "none" },
                    tab: undefined,
                });
            await first.reload();
            await first.waitForFunction(() => Reflect.has(window, "serverTest"), null, { timeout: 20_000 });
            expect(await run(first, "connections")).toMatchObject([
                { userId: "alice", state: { status: "active" } },
            ]);
            expect(await run(first, "pin", "first-ontology")).toMatchObject({ device: { ready: true } });
            await run(second, "clearPin", "first-ontology");
            expect(await run(first, "pin", "first-ontology")).toEqual({ device: undefined, tab: undefined });
            await expect
                .poll(async () =>
                    ((await run(second, "pinEvents", "first-ontology")) as { values: unknown[] }).values.at(
                        -1
                    )
                )
                .toBeUndefined();
            expect(
                ((await run(second, "pinEvents", "first-ontology")) as { errors: unknown[] }).errors
            ).toEqual([]);
            await run(second, "stopPinWatch", "first-ontology");
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
            await run(first, "forget");
            for (const page of [first, second]) await expect.poll(() => run(page, "connections")).toEqual([]);
            // Forget removes local credentials/cache, not the authoritative objects.
            await run(first, "signIn", "alice");
            await expect
                .poll(() => run(first, "rows", "first-ontology"))
                .toMatchObject([{ id: "one", count: 1 }]);
            expect(errors).toEqual([]);
        } finally {
            await Promise.allSettled([first, second].map((page) => run(page, "cleanup")));
            await context.close();
        }
    }
);

test("server startup failures reach the client without hanging worker acquisition", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(`${origin}e2e/multi-ontology-tab.html?scope=fail:${crypto.randomUUID()}`);
        await page.waitForFunction(() => Reflect.has(window, "serverFailure"), null, {
            timeout: 5_000,
        });
        expect(
            await page.evaluate(() => {
                const error = Reflect.get(window, "serverFailure") as {
                    _tag: string;
                    kind: string;
                    message: string;
                };
                return { _tag: error._tag, kind: error.kind, message: error.message };
            })
        ).toEqual({
            _tag: "BackendError",
            kind: "InvalidConfiguration",
            message: "The operation could not be completed.",
        });
    } finally {
        await context.close();
    }
});
