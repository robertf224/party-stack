// Read-only integration: provider-owned view, native Suspense readers and pagination.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const browser = await chromium.launch();
try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        ignoreHTTPSErrors: process.env.PARTY_INSECURE_LOCAL_TLS === "1",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL("/", base).href);
    const list = page.getByRole("listbox", { name: "Notes", exact: true });
    await list.waitFor();
    const shell = await page.locator(".notes-app").elementHandle();
    const first = list.locator(".note-preview").first();
    const id = await first.getAttribute("data-note-id");
    assert(id);
    await first.click();
    const editor = page.locator(`.note-page[data-note-id="${id}"]`);
    await editor.waitFor();
    assert(await shell.evaluate((node) => node.isConnected), "note selection remounted the workspace");
    await page.reload();
    await editor.waitFor();
    await list.waitFor();
    await page.locator('.sidebar a[href="/trash"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".note-preview").length === 50);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".note-preview").length === 100);
    await page.locator('.sidebar a[href="/"]').click();
    await list.waitFor();
    await list.locator(`.note-preview[data-note-id="${id}"]`).waitFor();
    await page.waitForFunction(
        () => document.querySelector(".boot-workspace")?.style.visibility === "visible"
    );
    assert.equal(
        await page.locator(".opening:visible").count(),
        0,
        "navigation returned to the startup splash"
    );
    const mobile = await browser.newPage({
        viewport: { width: 390, height: 844 },
        ignoreHTTPSErrors: process.env.PARTY_INSECURE_LOCAL_TLS === "1",
    });
    mobile.on("pageerror", (error) => errors.push(error.message));
    await mobile.goto(new URL(`/notes/${encodeURIComponent(id)}`, base).href);
    await mobile.locator(`.note-page[data-note-id="${id}"]`).waitFor();
    await mobile.waitForFunction(
        () => document.querySelector(".boot-workspace")?.style.visibility === "visible"
    );
    await mobile.close();
    assert.deepEqual(errors, []);
    console.log(
        "Native Suspense startup, stable workspace navigation, desktop/mobile detail reloads, Trash pagination 50→100, and return to Notes passed."
    );
} finally {
    await browser.close();
}
