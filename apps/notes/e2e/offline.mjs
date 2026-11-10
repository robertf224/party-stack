// Isolated browser storage; fixtures are archived after the check.
import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? new URL("/api/ontology/rpc", base)),
});
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const defaultNote = crypto.randomUUID();
const workNote = crypto.randomUUID();
const routeNote = crypto.randomUUID();
const attachmentId = crypto.randomUUID();
const workFolder = crypto.randomUUID();
const title = `Folder download fixture ${Date.now()}`;
const folderName = `Download check ${Date.now()}`;
const createdNotes = [];
let folderCreated = false;
async function folder(name) {
    const menu = page.getByRole("button", { name: "Open menu", exact: true }).filter({ visible: true });
    if (await menu.count()) await menu.click();
    await page.getByRole("link", { name, exact: true }).filter({ visible: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
}
try {
    await sdk.actions.createNotebook({ id: workFolder, name: folderName, color: "#829bbc" });
    folderCreated = true;
    await sdk.actions.createNote({
        id: defaultNote,
        title: `${title} default`,
        notebookId: "device:notes",
        kind: "note",
    });
    createdNotes.push(defaultNote);
    await sdk.actions.createNote({ id: workNote, title, notebookId: workFolder, kind: "note" });
    createdNotes.push(workNote);
    await sdk.actions.createNote({
        id: routeNote,
        title: "Editor route fixture",
        notebookId: workFolder,
        kind: "note",
    });
    createdNotes.push(routeNote);
    const { attachment } = await sdk.attachments.create(
        new File(["Whole-device offline bytes."], "folder-download.txt", { type: "text/plain" }),
        { target: { kind: "actionParameter", actionType: "addAttachment", parameter: "file" } }
    );
    await sdk.actions.addAttachment({ id: attachmentId, noteId: workNote, file: attachment });
    await sdk.actions.updateNote({
        note: workNote,
        bodyMarkdown: `![folder-download.txt](attachment:${attachmentId})`,
    });
    await page.goto(base);
    await page.locator(`.note-preview[data-note-id="${defaultNote}"]`).waitFor();
    assert.equal(
        await page.locator(`.note-preview[data-note-id="${workNote}"]`).count(),
        0,
        "Notes must contain only the default folder"
    );
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).count(), 0);
    assert.equal(
        await page
            .getByRole("link", { name: "Notes", exact: true })
            .getByRole("img", { name: "Available offline" })
            .count(),
        0
    );
    // Warm only the editor code using a different note. The downloaded attachment
    // remains unopened, so the download must supply its bytes.
    await folder(folderName);
    await page.locator(`.note-preview[data-note-id="${routeNote}"]`).click();
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    await folder("Notes");
    await setFolderDownload(page, true);
    const notesLink = page.getByRole("link", { name: "Notes", exact: true });
    await notesLink.getByRole("img", { name: "Available offline" }).waitFor();
    // The second tab observes the same persistent owner's pin collection.
    const other = await context.newPage();
    await other.goto(base);
    await other.locator('.folder-download[data-status="ready"]').waitFor();
    await setFolderDownload(page, false);
    await other.locator('.folder-download[data-status="off"]').waitFor();
    await notesLink.getByRole("img", { name: "Available offline" }).waitFor({ state: "detached" });
    await page.evaluate(() => {
        window.pinStates = [];
        const setting = document.querySelector(".folder-download");
        new MutationObserver(() => {
            const next = setting.getAttribute("data-status");
            if (window.pinStates.at(-1) !== next) window.pinStates.push(next);
        }).observe(setting, { attributes: true, attributeFilter: ["data-status"] });
    });
    await setFolderDownload(page, true, { wait: false });
    await setFolderDownload(page, false);
    // Wait only in the test to catch late obsolete status publication.
    await page.waitForTimeout(750);
    const states = await page.evaluate(() => window.pinStates);
    const cleared = states.indexOf("off");
    assert(
        cleared >= 0 && states.slice(cleared).every((value) => value === "off"),
        `Cleared pin flashed: ${states}`
    );
    await setFolderDownload(page, true);
    await other.close();
    await page.reload();
    await page.locator('.folder-download[data-status="ready"]').waitFor();
    await folder(folderName);
    await setFolderDownload(page, true);
    await page
        .getByRole("link", { name: folderName, exact: true })
        .getByRole("img", { name: "Available offline" })
        .waitFor();
    await page.screenshot({ path: "/tmp/party-notes-folder-downloads.png" });

    await page.getByLabel("Open Ontology devtools", { exact: true }).click();
    await page.getByRole("tab", { name: "Pinned", exact: true }).click({ timeout: 30_000 });
    const panel = page.getByRole("tabpanel", { name: "Pinned", exact: true });
    await panel.locator(".ps-query-node").first().waitFor();
    assert.equal(await panel.getByRole("heading", { name: "downloadFolder", exact: true }).count(), 1);
    assert.equal(await panel.locator(".ps-pin-download").count(), 2);
    assert.equal(await panel.locator(".ps-query-document").count(), 1);
    const scroller = panel.locator(".ps-pinned-inventory");
    assert(
        await scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
        "Inventory needs overflow for this test"
    );
    await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
    });
    assert(await scroller.evaluate((el) => el.scrollTop > 0), "Pinned inventory must scroll");
    assert.match(await panel.innerText(), /Available offline/);
    assert.match(await panel.innerText(), /Includes attachment bytes/);
    await scroller.evaluate((el) => {
        el.scrollTop = 0;
    });
    await page.screenshot({ path: "/tmp/party-pinned-notes.png" });
    const defaultRow = panel.locator(".ps-pin-download").filter({ hasText: "device:notes" });
    await defaultRow.getByRole("button", { name: "Remove", exact: true }).click();
    await defaultRow.waitFor({ state: "detached" });
    await page
        .getByRole("link", { name: "Notes", exact: true })
        .getByRole("img", { name: "Available offline" })
        .waitFor({ state: "detached" });
    assert.equal(await panel.locator(".ps-pin-download").count(), 1);
    await page.getByTestId("tsd-close-button").click();
    console.log("Plural Pinned inspector and scrolling verified");

    // Reload discarded the development route module. Warm that code again with
    // another note, leaving the attachment's note unopened.
    await page.locator(`.note-preview[data-note-id="${routeNote}"]`).click();
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    await folder(folderName);
    // Pinning, not opening an editor, made these attachment bytes available.
    await context.setOffline(true);
    await page.locator(`.note-preview[data-note-id="${workNote}"]`).click();
    const file = page.getByRole("link", { name: /folder-download.txt/ });
    await file.waitFor();
    assert.match(await file.getAttribute("href"), /^blob:/);
    console.log("Unopened attachment available offline");
    await context.setOffline(false);

    // Search across folders must navigate to the result's real folder.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: "Back to notes", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Search notes", exact: true }).filter({ visible: true }).click();
    const search = page.getByRole("dialog", { name: "Search notes", exact: true });
    await search.getByRole("textbox", { name: "Search all notes", exact: true }).fill(`${title} default`);
    await search.getByRole("link", { name: `${title} default`, exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/notes/${defaultNote}`);

    await page.getByRole("link", { name: "Back to notes", exact: true }).filter({ visible: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await setFolderDownload(page, true);
    await setFolderDownload(page, false);
    const buttonBox = await page.getByRole("button", { name: "Download folder", exact: true }).boundingBox();
    assert(buttonBox && buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= 390);
    assert.deepEqual(errors, []);
    console.log(
        "PASS: folder downloads, ready-only sidebar indicators, cross-tab status, rapid cancellation, reload, scrolling inspector, unopened offline attachment and mobile controls."
    );
} catch (error) {
    console.error("URL:", page.url());
    console.error("Page errors:", errors);
    console.error((await page.locator("body").innerText()).slice(-5000));
    await page.screenshot({ path: "/tmp/party-offline-failure.png" });
    throw error;
} finally {
    await context.setOffline(false);
    await browser.close();
    for (const note of createdNotes) await sdk.actions.updateNote({ note, trashed: true });
    if (folderCreated) await sdk.actions.deleteNotebook({ notebook: workFolder });
    await sdk.cleanup();
}
