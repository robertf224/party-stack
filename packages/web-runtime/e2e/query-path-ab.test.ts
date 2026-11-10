import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
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

test("matched visible read and speculative delivery over one ready IndexedDB parent", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(`${origin}e2e/query-path-tab.html?scope=${crypto.randomUUID()}`);
        await page.waitForFunction(() => Boolean(document.getElementById("result")?.textContent), null, {
            timeout: 90_000,
        });
        const result = JSON.parse((await page.locator("#result").textContent())!) as {
            error?: unknown;
            assertions?: Record<string, boolean>;
        };
        await writeFile("/tmp/party-query-path-ab.json", JSON.stringify(result, null, 2));
        expect(errors).toEqual([]);
        expect(result.error).toBeUndefined();
        expect(result.assertions).toEqual({
            matchedInitialUnion: true,
            matchedEditedUnion: true,
            acceptedUnexecuted: true,
            speculativeBaselinePreserved: true,
        });
        console.log("Matched query-path measurements: /tmp/party-query-path-ab.json");
    } finally {
        await context.close();
    }
}, 120_000);
