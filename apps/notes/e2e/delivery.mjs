// Run against the local Notes preview. Only this probe's disposable folder is archived.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";
import { readTabTraces } from "./storage-counters.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const editCount = Number(process.env.PARTY_DELIVERY_EDITS ?? 3);
assert(Number.isSafeInteger(editCount) && editCount >= 1 && editCount <= 20);
const fixturePath = process.env.PARTY_FOLDER_FIXTURE;
const sharedFixture = fixturePath ? JSON.parse(await readFile(fixturePath, "utf8"))[0] : undefined;
if (fixturePath) {
    assert.equal(typeof sharedFixture?.id, "string");
    assert.equal(typeof sharedFixture?.name, "string");
    assert.equal(typeof sharedFixture?.notes?.[0], "string");
}
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? "http://127.0.0.1:5173/api/ontology/rpc"),
});
const browser = await chromium.launch(
    process.env.PARTY_BROWSER_CHANNEL ? { channel: process.env.PARTY_BROWSER_CHANNEL } : {}
);
console.log("Browser:", browser.version(), process.env.PARTY_BROWSER_CHANNEL ?? "bundled-chromium");
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
context.setDefaultTimeout(30_000);
const folder = sharedFixture?.id ?? crypto.randomUUID();
const note = sharedFixture?.notes[0] ?? crypto.randomUUID();
const text = sharedFixture ? `${sharedFixture.name} 0` : `Delivery ${crypto.randomUUID().slice(0, 8)}`;
const errors = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
let created = false;
try {
    if (!sharedFixture) {
        await sdk.actions.createNotebook({ id: folder, name: text, color: "#829bbc" });
        created = true;
        await sdk.actions.createNote({ id: note, notebookId: folder, title: text, kind: "note" });
    } else console.log("Reusing delivery fixture", { folder, note });
    await sdk.actions.updateNote({ note, title: text, bodyMarkdown: text });
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    for (const page of pages) {
        // Visit the folder before going offline so its development route module
        // is loaded as well as the note route. This probe exercises data delivery.
        await page.goto(new URL(`/folders/${folder}`, base).href);
        await page.locator(`.note-preview[data-note-id="${note}"]`).click();
        await page.waitForFunction(
            (text) => document.querySelector(".markdown-editor")?.textContent === text,
            text
        );
    }
    if (process.env.PARTY_DOWNLOAD_OFFLINE === "1") {
        await setFolderDownload(pages[0], true);
        console.log("Offline coverage ready before background-view measurement");
    }
    const collectTraces = process.env.PARTY_COLLECT_TRACES === "1";
    if (collectTraces) for (const page of pages) await page.evaluate(readTabTraces, "start");
    if (process.env.PARTY_BACKGROUND_TRASH === "1") {
        const trash = await context.newPage();
        const started = performance.now();
        await trash.goto(new URL("/trash", base).href);
        await trash.locator(".note-preview").nth(49).waitFor();
        console.log("Background Recently Deleted ready:", Math.round(performance.now() - started), "ms");
    }
    const timings = [];
    const edits = [];
    try {
        for (let i = 0; i < editCount; i++) {
            const value = `${text} edit ${i}`;
            const started = performance.now();
            const edit = { index: i, epoch: performance.timeOrigin + started };
            edits.push(edit);
            await pages[i % 2].getByRole("textbox", { name: "Note content", exact: true }).fill(value);
            await pages[(i + 1) % 2].waitForFunction(
                (value) => document.querySelector(".markdown-editor")?.textContent === value,
                value
            );
            timings.push(Math.round(performance.now() - started));
            edit.durationMs = timings.at(-1);
        }
    } finally {
        if (collectTraces) {
            const traces = [];
            for (const page of pages) traces.push(await page.evaluate(readTabTraces, "stop"));
            await writeFile(
                "/tmp/party-notes-delivery-full-traces.json",
                JSON.stringify({ edits, traces }, null, 2)
            );
        }
        const cdp = await browser.newBrowserCDPSession();
        const targets = await cdp.send("Target.getTargets");
        const target = targets.targetInfos.find(
            (entry) => entry.type === "shared_worker" && entry.url.includes("ontology.worker.ts")
        );
        if (target) {
            const report = await pages[0].evaluate(async (url) => {
                const { inspectWorker } = await import("/e2e/inspect-worker.ts");
                return inspectWorker(url);
            }, target.url);
            await writeFile("/tmp/party-notes-delivery-worker.json", JSON.stringify(report, null, 2));
        }
        await cdp.detach();
        console.log("Cross-tab edits, including editor debounce:", timings, "ms");
    }
    assert.deepEqual(errors, []);
    assert(
        timings.every((ms) => ms < 2500),
        "Local cross-tab edits must not wait seconds in the outbox"
    );
    if (!sharedFixture) {
        await context.setOffline(true);
        const preview = pages[0].locator(`.note-preview[data-note-id="${note}"]`);
        await preview.focus();
        const removed = performance.now();
        await preview.press("Backspace");
        await preview.waitFor({ state: "hidden" });
        console.log("Offline delete to list removal:", Math.round(performance.now() - removed), "ms");
        await pages[0].waitForURL((url) => url.pathname === `/folders/${folder}`);
        const removalMs = Math.round(performance.now() - removed);
        console.log("Offline delete to list removal and folder navigation:", removalMs, "ms");
        assert(removalMs < 1000, "Deletion must be optimistic while the HTTP parent is unavailable");
        await pages[1].locator(`.note-preview[data-note-id="${note}"]`).waitFor({ state: "hidden" });
        assert.deepEqual(errors, []);
        console.log("PASS: alternating edits and optimistic offline deletion update both tabs");
    } else console.log("PASS: alternating edits update both tabs; shared fixture preserved");
} finally {
    await context.setOffline(false);
    await browser.close();
    if (sharedFixture) await sdk.actions.updateNote({ note, title: text, bodyMarkdown: text });
    if (created) await sdk.actions.deleteNotebook({ notebook: folder });
    await sdk.cleanup();
}
