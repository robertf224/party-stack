import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const baseline = process.argv.includes("--baseline");
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const empty = crypto.randomUUID();
const anchor = crypto.randomUUID();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
    window.listAudit = { skeletons: [], visibleSkeletons: [], rpc: [] };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
        const record = (message) => {
            if (Array.isArray(message)) return message.forEach(record);
            if (message?._tag === "Request")
                window.listAudit.rpc.push({ at: performance.now(), name: message.tag });
        };
        record(args[0]);
        return post.apply(this, args);
    };
});
try {
    await sdk.actions.createNote({ id: empty, title: "", notebookId: "device:personal", kind: "note" });
    await sdk.actions.createNote({
        id: anchor,
        title: "Keyboard focus fixture",
        notebookId: "device:personal",
        kind: "note",
    });
    await page.goto(process.argv[2]);
    const list = page.getByRole("listbox", { name: "Notes", exact: true });
    await list.waitFor();
    await page.locator(`.note-preview[data-note-id="${anchor}"]`).focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith(empty));
    await page.locator(`.note-page[data-note-id="${empty}"] .markdown-editor`).waitFor();
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const focusStayed = await page.evaluate(
        (id) => document.activeElement?.getAttribute("data-note-id") === id,
        empty
    );
    console.log("Keyboard selection of empty note keeps list focus:", focusStayed);
    if (!baseline) assert(focusStayed);
    if (focusStayed) {
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(
            () => document.activeElement?.getAttribute("aria-label") === "Note content"
        );
    }
    await page.getByRole("button", { name: "Open TanStack Devtools", exact: true }).click();
    await page.getByRole("tab", { name: "Tracing", exact: true }).click();
    await page.getByRole("checkbox", { name: "Child spans", exact: true }).check();
    await page.evaluate(() => {
        const sample = () => {
            for (const element of document.querySelectorAll(".list-skeleton,.preview-skeleton"))
                if (element.getClientRects().length && getComputedStyle(element).visibility === "visible")
                    window.listAudit.visibleSkeletons.push({
                        at: performance.now(),
                        className: element.className,
                        view: location.search,
                    });
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        new MutationObserver((records) => {
            for (const record of records)
                for (const node of record.addedNodes)
                    if (node instanceof Element)
                        for (const element of [
                            node,
                            ...node.querySelectorAll(".list-skeleton,.preview-skeleton"),
                        ])
                            if (element.matches(".list-skeleton,.preview-skeleton"))
                                window.listAudit.skeletons.push({
                                    at: performance.now(),
                                    className: element.className,
                                    view: location.search,
                                });
        }).observe(document.querySelector(".note-list"), { childList: true, subtree: true });
    });
    const measurements = [];
    for (const name of [
        "Work",
        "Personal",
        "Ideas",
        "Personal",
        "Work",
        "Notes",
        "Work",
        "Personal",
        "Notes",
    ]) {
        const started = await page.evaluate(() => performance.now());
        await page.getByRole("link", { name, exact: true }).click();
        await page.getByRole("heading", { name, exact: true }).waitFor();
        await list.waitFor();
        await page.locator(".list-skeleton").waitFor({ state: "hidden" });
        await page.locator(".preview-skeleton").first().waitFor({ state: "hidden" });
        measurements.push({
            name,
            ms: await page.evaluate((at) => Math.round(performance.now() - at), started),
        });
    }
    const traces = {};
    for (const source of ["1", "0"]) {
        await page.getByRole("combobox", { name: "Trace source", exact: true }).selectOption(source);
        await page.getByRole("checkbox", { name: "Child spans", exact: true }).check();
        traces[source] = await page.getByRole("table", { name: "Tracing timeline", exact: true }).innerText();
    }
    const audit = await page.evaluate(() => window.listAudit);
    console.log("Folder navigation:", measurements);
    console.log("Skeletons:", audit.skeletons);
    console.log("Visible skeletons:", audit.visibleSkeletons);
    console.log(
        "RPC counts:",
        audit.rpc.reduce((counts, item) => ({ ...counts, [item.name]: (counts[item.name] ?? 0) + 1 }), {})
    );
    await writeFile(
        `/tmp/party-notes-list-${baseline ? "before" : "after"}.json`,
        JSON.stringify({ measurements, ...audit, traces }, null, 2)
    );
    await page.screenshot({ path: `/tmp/party-notes-list-${baseline ? "before" : "after"}.png` });
    if (!baseline)
        assert.equal(
            audit.visibleSkeletons.length,
            0,
            "cached filters should not display list or preview skeletons"
        );
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    for (const id of [empty, anchor]) await sdk.actions.updateNote({ note: id, trashed: true });
    await sdk.cleanup();
}
