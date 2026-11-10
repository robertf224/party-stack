// Exercise quick multi-note creation/deletion through the actual app UI.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? "http://127.0.0.1:5173/api/ontology/rpc"),
});
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
context.setDefaultTimeout(15_000);
const page = await context.newPage();
const folder = crypto.randomUUID();
const ids = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let created = false;
let deleting;
try {
    await sdk.actions.createNotebook({
        id: folder,
        name: `Deletion ${folder.slice(0, 8)}`,
        color: "#829bbc",
    });
    created = true;
    await page.goto(new URL(`/folders/${folder}`, base).href);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.evaluate(() => import("/e2e/inspect-tab.ts"));
    if (["pinned", "cached"].includes(process.argv[4])) {
        await setFolderDownload(page, true);
        if (process.argv[4] === "cached") await setFolderDownload(page, false);
    }
    for (const offline of [false, true]) {
        await context.setOffline(offline);
        const batch = [];
        for (let i = 0; i < 4; i++) {
            await page
                .getByRole("button", { name: "New note", exact: true })
                .filter({ visible: true })
                .click();
            await page.getByRole("menuitem", { name: "Note", exact: true }).click();
            await page.waitForURL(
                (url) =>
                    url.pathname.startsWith(`/folders/${folder}/`) &&
                    !ids.includes(url.pathname.split("/").at(-1))
            );
            const id = new URL(page.url()).pathname.split("/").at(-1);
            ids.push(id);
            batch.push(id);
            const editor = page.locator(`.note-page[data-note-id="${id}"] [aria-label="Note content"]`);
            await editor.waitFor();
            if (i % 2) {
                const title = `Delete ${id.slice(0, 8)}`;
                await editor.fill(title);
                await page.getByRole("option", { name: new RegExp(`^${title}`) }).waitFor();
            }
        }
        for (const id of [batch[1], batch[3], batch[0]]) {
            await page.evaluate(async () => (await import("/e2e/inspect-tab.ts")).recordTabChanges());
            const row = page.locator(`.note-preview[data-note-id="${id}"]`);
            await row.click();
            const visible = await page
                .locator(".note-preview")
                .evaluateAll((rows) => rows.map((row) => row.dataset.noteId));
            const position = visible.indexOf(id);
            const adjacent = visible[position + 1] ?? visible[position - 1];
            await row.focus();
            const contextMenu = id === batch[3];
            if (contextMenu) await row.click({ button: "right" });
            const started = performance.now();
            deleting = { id, started };
            if (contextMenu) await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
            else await row.press("Backspace");
            await row.waitFor({ state: "hidden", timeout: 1500 });
            const ms = Math.round(performance.now() - started);
            console.log(
                offline ? "Offline" : "Online",
                contextMenu ? "context delete" : "keyboard delete",
                id,
                ms,
                "ms"
            );
            assert(ms < 1000, "A deleted note must leave the live list optimistically");
            await page.waitForURL(
                (url) => url.pathname === (adjacent ? `/folders/${folder}/${adjacent}` : `/folders/${folder}`)
            );
            if (adjacent)
                await page
                    .locator(`.note-page[data-note-id="${adjacent}"] [aria-label="Note content"]`)
                    .waitFor();
        }
    }
    await context.setOffline(false);
    const remaining = await page
        .locator(".note-preview")
        .evaluateAll((rows) => rows.map((row) => row.dataset.noteId));
    await page.locator(`.note-preview[data-note-id="${remaining[0]}"]`).click();
    await page.getByRole("button", { name: "Move to recently deleted", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/folders/${folder}/${remaining[1]}`);
    await page.locator(`.note-page[data-note-id="${remaining[1]}"] [aria-label="Note content"]`).waitFor();
    console.log("PASS: toolbar deletion opens the adjacent note on desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Note options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/folders/${folder}`);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    console.log("PASS: mobile deletion returns to the folder");
    assert.deepEqual(errors, []);
    console.log("PASS: newly created empty and typed notes leave a multi-note fragment list immediately");
} catch (error) {
    try {
        const tab = await page.evaluate(async (ids) => {
            const { inspectTab } = await import("/e2e/inspect-tab.ts");
            return inspectTab(ids);
        }, ids);
        await writeFile("/tmp/party-notes-deletion-tab.json", JSON.stringify(tab, null, 2));
        console.error("Tab sources:", JSON.stringify(tab.sources));
        if (deleting) {
            try {
                await page
                    .locator(`.note-preview[data-note-id="${deleting.id}"]`)
                    .waitFor({ state: "hidden", timeout: 30_000 });
                console.error(
                    "Eventually removed in",
                    Math.round(performance.now() - deleting.started),
                    "ms"
                );
            } catch {
                console.error("Still listed after 30 seconds");
            }
        }
    } catch (failure) {
        console.error("Tab inspection:", String(failure));
    }
    console.error("Deletion state:", {
        url: page.url(),
        ids,
        errors,
        rows: await page
            .locator(".note-preview")
            .evaluateAll((rows) => rows.map((row) => ({ id: row.dataset.noteId, text: row.textContent }))),
    });
    await page.screenshot({ path: "/tmp/party-notes-deletion-failure.png" });
    try {
        const cdp = await browser.newBrowserCDPSession();
        const { targetInfos } = await cdp.send("Target.getTargets");
        const target = targetInfos.find(
            (target) => target.type === "shared_worker" && target.url.includes("ontology.worker.ts")
        );
        if (target) {
            const state = await page.evaluate(
                async ({ url, ids }) => {
                    const { inspectWorker } = await import("/e2e/inspect-worker.ts");
                    return inspectWorker(url, ids);
                },
                { url: target.url, ids }
            );
            await writeFile("/tmp/party-notes-deletion-worker.json", JSON.stringify(state, null, 2));
        }
        await cdp.detach();
        await page.getByLabel("Open Ontology devtools", { exact: true }).click();
        await page.getByRole("tab", { name: "Objects", exact: true }).click();
        const panel = page.getByRole("tabpanel", { name: "Objects", exact: true });
        await panel.getByRole("button", { name: "Notes", exact: true }).click();
        const sort = panel.getByTitle("Sort by updatedAt", { exact: true });
        for (let i = 0; i < 3 && !(await sort.innerText()).includes("Sorted descending"); i++)
            await sort.click();
        for (const id of ids) {
            const row = panel.getByRole("row").filter({ hasText: id });
            await row.waitFor({ timeout: 5000 });
            console.error("Tab cached row:", await row.locator("td").allTextContents());
        }
        console.error(
            "List after inspection:",
            await page.locator(".note-preview").evaluateAll((rows) => rows.map((row) => row.dataset.noteId))
        );
    } catch (failure) {
        console.error("Inspector:", String(failure));
    }
    throw error;
} finally {
    await context.setOffline(false);
    await browser.close();
    if (created) await sdk.actions.deleteNotebook({ notebook: folder });
    await sdk.cleanup();
}
