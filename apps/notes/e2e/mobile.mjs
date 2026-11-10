// Exercise real mobile controls and a worker-owned offline pin. All writes use
// disposable notes; the browser context owns its own local cache and settings.
import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
console.log("Opening fixture client");
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? new URL("/api/ontology/rpc", base)),
});
console.log("Fixture client ready");
const testFolders = ["Editor", "Offline"].map((name) => ({
    id: crypto.randomUUID(),
    name: `Phone ${name} ${Date.now()}`,
    color: "#829bbc",
}));
const createdFolders = [];
const fixture = crypto.randomUUID();
const fileRow = crypto.randomUUID();
const fixtureTitle = `Offline mobile fixture ${Date.now()}`;
const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    colorScheme: "dark",
});
const page = await context.newPage();
const errors = [];
let created;
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
    window.routeTransitions = [];
    const start = document.startViewTransition?.bind(document);
    if (start)
        document.startViewTransition = (options) => {
            if (typeof options === "object" && options.types)
                window.routeTransitions.push([...options.types]);
            return start(options);
        };
});
try {
    for (const folder of testFolders) {
        await sdk.actions.createNotebook(folder);
        createdFolders.push(folder.id);
    }
    await sdk.actions.createNote({
        id: fixture,
        title: fixtureTitle,
        notebookId: testFolders[1].id,
        kind: "note",
    });
    const { attachment } = await sdk.attachments.create(
        new File(["Available from the device's offline pin."], "offline-mobile.txt", { type: "text/plain" }),
        { target: { kind: "actionParameter", actionType: "addAttachment", parameter: "file" } }
    );
    await sdk.actions.addAttachment({ id: fileRow, noteId: fixture, file: attachment });
    await sdk.actions.updateNote({
        note: fixture,
        bodyMarkdown: `![offline-mobile.txt](attachment:${fileRow})`,
    });
    console.log("Fixture seeded; opening mobile browser");
    await page.goto(base);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector(".notes-app")).borderTopLeftRadius),
        "0px"
    );
    await page.getByRole("button", { name: "Open menu", exact: true }).filter({ visible: true }).tap();
    const folders = page.getByRole("dialog", { name: "Folders", exact: true });
    await folders.getByRole("link", { name: testFolders[0].name, exact: true }).tap();
    await page.getByRole("heading", { name: testFolders[0].name, exact: true }).waitFor();
    await page.waitForFunction(() => {
        const icon = document.querySelector(".list-heading .view-icon");
        return icon && getComputedStyle(icon).color === "rgb(130, 155, 188)";
    });
    await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).tap();
    await page.getByRole("menuitem", { name: "Note", exact: true }).tap();
    await page.waitForURL((url) => /^\/folders\/[^/]+\/[^/]+$/.test(url.pathname));
    assert.equal(new URL(page.url()).search, "");
    created = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
    const editor = page
        .locator(`.note-page[data-note-id="${created}"]`)
        .getByRole("textbox", { name: "Note content", exact: true });
    await editor.waitFor();
    await page.waitForFunction(
        (id) => document.activeElement?.closest(".note-page")?.getAttribute("data-note-id") === id,
        created
    );
    const title = `Mobile controls audit ${Date.now()}`;
    await page.keyboard.type(title);
    assert.equal(
        await page
            .getByRole("toolbar", { name: "Text formatting", exact: true })
            .filter({ visible: true })
            .count(),
        0
    );
    assert.equal(
        await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).count(),
        0
    );
    const insertButton = await page
        .getByRole("button", { name: "Insert into note", exact: true })
        .boundingBox();
    assert(insertButton.width >= 44 && insertButton.height >= 44, "insert target was squashed");
    const back = page.getByRole("link", { name: "Back to notes", exact: true });
    assert.match(await back.textContent(), /Back/);
    assert((await back.boundingBox()).width >= 70);
    await editor.press("Enter");
    await page.getByRole("button", { name: "Insert into note", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Checklist", exact: true }).tap();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    // Use the keyboard directly: focusing the editor through a locator would
    // conceal a menu that failed to return focus to the actual task item.
    await page.keyboard.type("First item");
    assert.equal(await editor.locator('ul[data-type="taskList"] > li p').first().textContent(), "First item");
    const task = await editor
        .locator('ul[data-type="taskList"] > li')
        .first()
        .evaluate((element) => {
            const checkbox = element.querySelector("input").getBoundingClientRect();
            const text = element.querySelector("p").getBoundingClientRect();
            return {
                difference: Math.abs(checkbox.y + checkbox.height / 2 - (text.y + text.height / 2)),
                display: getComputedStyle(element).display,
            };
        });
    assert.equal(task.display, "flex");
    assert(task.difference < 8, `task text appeared below the checkbox (${task.difference}px)`);
    await back.tap();
    await page.getByRole("button", { name: "Search notes", exact: true }).filter({ visible: true }).tap();
    const search = page.getByRole("dialog", { name: "Search notes", exact: true });
    await search.getByRole("textbox", { name: "Search all notes", exact: true }).fill(title);
    await search.getByRole("link", { name: title, exact: true }).waitFor();
    await search.getByRole("button", { name: "Close search", exact: true }).tap();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: "/tmp/party-notes-mobile-controls.png" });
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.getByRole("button", { name: "Search notes", exact: true }).filter({ visible: true }).tap();
    await search.getByRole("textbox", { name: "Search all notes", exact: true }).fill(title);
    await search.getByRole("link", { name: title, exact: true }).tap();
    await editor.waitFor();
    const transitions = await page.evaluate(() => window.routeTransitions.flat());
    assert(
        transitions.includes("notes-forward") && transitions.includes("notes-back"),
        "route slides were not requested"
    );
    await back.tap();
    await page.getByRole("button", { name: "Open menu", exact: true }).filter({ visible: true }).tap();
    await folders.getByRole("link", { name: testFolders[1].name, exact: true }).tap();
    await setFolderDownload(page, true);
    // This attachment's note has never been opened in this browser. Only the
    // device pin could have downloaded its bytes before going offline.
    await context.setOffline(true);
    await page.getByRole("button", { name: "Search notes", exact: true }).filter({ visible: true }).tap();
    await search.getByRole("textbox", { name: "Search all notes", exact: true }).fill(fixtureTitle);
    await search.getByRole("link", { name: fixtureTitle, exact: true }).tap();
    const file = page.getByRole("link", { name: /offline-mobile.txt/ });
    await file.waitFor();
    assert.match(await file.getAttribute("href"), /^blob:/);
    await back.tap();
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await setFolderDownload(page, false);
    await context.setOffline(false);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert(
        (
            await page
                .getByRole("button", { name: "New note", exact: true })
                .filter({ visible: true })
                .boundingBox()
        ).width >= 44
    );
    assert.deepEqual(errors, []);
    console.log(
        "PASS: mobile controls, checklist cursor/alignment, route slides, search, persisted device pin and an unopened attachment offline"
    );
} catch (error) {
    console.error("Page errors:", errors);
    console.error(await page.locator("body").innerText());
    await page.screenshot({ path: "/tmp/party-notes-mobile-controls-failure.png" });
    throw error;
} finally {
    await context.setOffline(false);
    await browser.close();
    for (const id of [created, fixture]) if (id) await sdk.actions.updateNote({ note: id, trashed: true });
    for (const id of createdFolders) await sdk.actions.deleteNotebook({ notebook: id });
    await sdk.cleanup();
}
