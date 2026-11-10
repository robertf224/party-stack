// Run against the Notes preview. Creates isolated folders and archives them on exit.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { eq, field, literal, selectField, sub } from "@party-stack/ontology/query";
import { Effect } from "effect";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? "http://127.0.0.1:5173/api/ontology/rpc"),
});
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
context.setDefaultTimeout(30_000);
const page = await context.newPage();
const errors = [];
context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
page.on("pageerror", (error) => errors.push(error.message));
const suffix = crypto.randomUUID().slice(0, 8);
const folders = ["A", "B"].map((label) => ({
    id: crypto.randomUUID(),
    name: `Fragments ${label} ${suffix}`,
}));
const notes = Array.from({ length: 55 }, (_, i) => ({
    id: crypto.randomUUID(),
    title: `Fragment ${suffix} ${i}`,
}));
const createdFolders = [];
let createdNote;
const timings = [];
async function folder(target, expected) {
    const start = performance.now();
    await page.getByRole("link", { name: target.name, exact: true }).click();
    await page.getByRole("heading", { name: target.name, exact: true }).waitFor();
    await page.waitForFunction((count) => {
        const list = [...document.querySelectorAll(".entries")].find(
            (element) => !element.closest("[inert]") && getComputedStyle(element).visibility !== "hidden"
        );
        return list && list.querySelectorAll(".note-preview").length === count;
    }, expected);
    timings.push(Math.round(performance.now() - start));
}
try {
    for (const target of folders) {
        await sdk.actions.createNotebook({ ...target, color: "#829bbc" });
        createdFolders.push(target.id);
    }
    await Promise.all(
        notes.map((note) => sdk.actions.createNote({ ...note, notebookId: folders[0].id, kind: "note" }))
    );
    const startup = performance.now();
    await page.goto(base);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    console.log("Fresh workspace:", Math.round(performance.now() - startup), "ms");
    await folder(folders[0], 50);
    await page.evaluate(() => {
        window.fragmentAudit = { skeletons: 0 };
        new MutationObserver((records) => {
            for (const record of records)
                for (const node of record.addedNodes) {
                    if (
                        node instanceof Element &&
                        (node.matches('.preview-skeleton,[aria-label="Opening folder"]') ||
                            node.querySelector('.preview-skeleton,[aria-label="Opening folder"]'))
                    )
                        window.fragmentAudit.skeletons++;
                }
        }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".note-preview").length === 55);
    assert.equal(await page.getByRole("button", { name: "Load more", exact: true }).count(), 0);
    assert.equal(
        await page.evaluate(() => window.fragmentAudit.skeletons),
        0,
        "Pagination must not remount/loading-flash the list"
    );
    const first = page.locator(".note-preview").first();
    const selected = await first.getAttribute("data-note-id");
    await first.focus();
    await first.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("note-preview")), true);
    await page.locator(".note-preview:focus").press("ArrowRight");
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    // An authoritative relationship move must update the independently rooted
    // list, and returning to that folder resets its page window.
    await sdk.actions.updateNote({ note: selected, notebookId: folders[1].id });
    await page.locator(`.note-preview[data-note-id="${selected}"]`).waitFor({ state: "hidden" });
    await folder(folders[1], 1);
    await folder(folders[0], 50);
    await folder(folders[1], 1);
    await folder(folders[0], 50);
    // New documents must be editable before a parent can acknowledge the write.
    await page.locator(".note-preview").first().click();
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    await context.setOffline(true);
    await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).click();
    const started = performance.now();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    await page.waitForURL(
        (url) => url.pathname.includes(folders[0].id) && !notes.some((note) => url.pathname.endsWith(note.id))
    );
    createdNote = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
    await page.locator(`.note-page[data-note-id="${createdNote}"] [aria-label="Note content"]`).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    const editorMs = Math.round(performance.now() - started);
    console.log("Offline new-note editor:", editorMs, "ms");
    assert(editorMs < 1500, "Optimistic local creation must not wait seconds for upstream");
    await page.getByRole("textbox", { name: "Note content", exact: true }).fill(`Instant ${suffix}`);
    await page.getByRole("option", { name: new RegExp(`^Instant ${suffix}`) }).waitFor();
    await context.setOffline(false);
    const peer = await context.newPage();
    await peer.goto(page.url());
    const peerEditor = peer.getByRole("textbox", { name: "Note content", exact: true });
    await peerEditor.waitFor();
    const sharedText = `Shared ${suffix}`;
    const deliveryStarted = performance.now();
    await peerEditor.fill(sharedText);
    await page.waitForFunction(
        (text) => document.querySelector(".markdown-editor")?.textContent === text,
        sharedText
    );
    const deliveryMs = Math.round(performance.now() - deliveryStarted);
    console.log("Cross-tab edit to visible:", deliveryMs, "ms (includes editor save debounce)");
    assert(deliveryMs < 2500, "A local cross-tab edit must not spend seconds waiting for a periodic sync");
    console.log("Folder click-to-list:", timings, "ms");
    assert.deepEqual(errors, []);
    console.log(
        "PASS: real Notes fragments, pagination, keyboard focus, relationship moves, offline creation and cross-tab delivery"
    );
} catch (error) {
    console.error("Fragment check failed:", error);
    console.error(
        "Editors:",
        await Promise.all(
            context.pages().map(async (tab) => ({
                url: tab.url(),
                text: await tab.locator(".markdown-editor").allTextContents(),
                boot: await tab.locator(".boot-workspace").getAttribute("style"),
                list: await tab.locator(".note-list").getAttribute("aria-busy"),
                opening: await tab.locator('[aria-label="Opening folder"]').count(),
                editor: await tab.locator(".markdown-editor").evaluateAll((elements) =>
                    elements.map((el) => ({
                        visible: getComputedStyle(el).visibility,
                        editable: el.getAttribute("contenteditable"),
                    }))
                ),
                errors: await tab.locator('[role="alert"]').allTextContents(),
            }))
        )
    );
    if (createdNote) {
        const rows = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const server = yield* httpClient(
                        process.argv[3] ?? "http://127.0.0.1:5173/api/ontology/rpc"
                    );
                    const remote = yield* server.ontology();
                    return yield* remote.backend.query({
                        select: [
                            sub("notes", {
                                from: { source: { objectType: "Note" }, binding: "note" },
                                where: eq(field("note", "id"), literal(createdNote)),
                                select: [
                                    selectField("title", field("note", "title")),
                                    selectField("body", field("note", "bodyMarkdown")),
                                ],
                            }),
                        ],
                    });
                })
            )
        );
        console.error("Authoritative fixture:", rows);
    }
    for (const [index, tab] of context.pages().entries())
        await tab.screenshot({ path: `/tmp/party-notes-fragments-failure-${index}.png` });
    try {
        const cdp = await browser.newBrowserCDPSession();
        const targets = await cdp.send("Target.getTargets");
        const target = targets.targetInfos.find(
            (entry) => entry.type === "shared_worker" && entry.url.includes("ontology.worker.ts")
        );
        if (target) {
            const worker = await page.evaluate(async (url) => {
                const { inspectWorker } = await import("/e2e/inspect-worker.ts");
                return inspectWorker(url);
            }, target.url);
            await writeFile("/tmp/party-notes-fragment-worker.json", JSON.stringify(worker, null, 2));
            console.error("Worker state:", {
                networkOnline: worker.status.status?.networkOnline,
                syncing: worker.status.status?.syncing,
                outbox: worker.status.status?.outbox,
                error: worker.status.error,
                report: "/tmp/party-notes-fragment-worker.json",
            });
        }
        await cdp.detach();
        await page.getByLabel("Open Ontology devtools", { exact: true }).click({ timeout: 10_000 });
        await page.getByRole("tab", { name: /^Outbox/ }).click({ timeout: 10_000 });
        console.error("Pending actions:", await page.getByRole("tabpanel", { name: /^Outbox/ }).innerText());
    } catch (inspection) {
        console.error("Inspector failure:", String(inspection));
    }
    throw error;
} finally {
    await context.setOffline(false);
    await browser.close();
    // The new note was created offline. Its parent may not have received it yet;
    // deleting the owned folder will archive it once forwarded.
    for (const id of createdFolders) await sdk.actions.deleteNotebook({ notebook: id });
    await sdk.cleanup();
}
