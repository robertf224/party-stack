import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { eq, field } from "@party-stack/ontology-storage/tables";
import { httpClient } from "@party-stack/ontology/http";
import { Effect } from "effect";
import { chromium } from "playwright";

const base = process.argv[2];
const rpc = "http://127.0.0.1:5173/api/ontology/rpc";
const sdk = await createLiveOntology({ client: httpClient(rpc) });
const folderId = crypto.randomUUID();
const noteId = crypto.randomUUID();
const title = `Folder menu ${folderId.slice(0, 6)}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const read = (type, id) =>
    Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* httpClient(rpc);
                const remote = yield* client.ontology();
                const result = yield* remote.backend.loadSubset(
                    objectSubset(type, { where: eq(field("id"), id) })
                );
                return result.rows[0]?.value;
            })
        )
    );
try {
    await sdk.actions.createNotebook({ id: folderId, name: title, color: "#d4a72c" });
    await sdk.actions.createNote({
        id: noteId,
        title: "Folder deletion fixture",
        notebookId: folderId,
        kind: "note",
    });
    await sdk.actions.updateNote({
        note: noteId,
        bodyMarkdown: "Folder deletion fixture\n\nKeep this document.",
    });
    await page.goto(base);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Folder options", exact: true }).count(), 0);
    // Warm the route's lazy module before testing offline data mutations.
    await page.getByRole("link", { name: "Recently deleted", exact: true }).click();
    await page.getByRole("heading", { name: "Recently deleted", exact: true }).waitFor();
    await page.getByRole("link", { name: title, exact: true }).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    await page.getByRole("link", { name: title, exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit folder…", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Edit folder", exact: true });
    assert.equal(await dialog.getByRole("textbox", { name: "Folder name", exact: true }).inputValue(), title);
    await dialog.getByRole("textbox", { name: "Folder name", exact: true }).fill(`${title} edited`);
    await dialog.getByRole("radio", { name: "Blue", exact: true }).click();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: `${title} edited`, exact: true }).waitFor();
    assert.equal(
        await page
            .getByRole("link", { name: `${title} edited`, exact: true })
            .locator("svg")
            .evaluate((el) => getComputedStyle(el).color),
        "rgb(130, 155, 188)"
    );
    await page.getByRole("button", { name: "Folder options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete folder…", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Delete folder?", exact: true });
    await dialog.getByText("Its notes will move to Recently Deleted.", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Folder options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit folder…", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Edit folder", exact: true });
    assert.equal(
        await dialog.getByRole("radio", { name: "Blue", exact: true }).getAttribute("aria-checked"),
        "true"
    );
    await context.setOffline(true);
    await dialog.getByRole("textbox", { name: "Folder name", exact: true }).fill(`${title} offline`);
    await dialog.getByRole("radio", { name: "Green", exact: true }).click();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: `${title} offline`, exact: true }).waitFor();
    await page.getByRole("button", { name: "Folder options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete folder…", exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/party-notes-folder-menu.png" });
    await page.getByRole("menuitem", { name: "Delete folder…", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Delete folder?", exact: true });
    await dialog.getByRole("button", { name: "Delete folder", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("heading", { name: "Notes", exact: true }).waitFor();
    await page.locator(`.note-preview[data-note-id="${noteId}"]`).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    assert.equal(await page.getByRole("link", { name: `${title} offline`, exact: true }).count(), 0);
    await page.getByRole("link", { name: "Recently deleted", exact: true }).click();
    await page.locator(`.note-preview[data-note-id="${noteId}"]`).waitFor();
    await context.setOffline(false);
    const deadline = Date.now() + 15_000;
    let saved;
    while (Date.now() < deadline) {
        const folder = await read("Notebook", folderId);
        saved = await read("Note", noteId);
        if (!folder && saved?.trashed && saved.notebookId === "device:notes") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await read("Notebook", folderId), undefined);
    assert.equal(saved?.trashed, true);
    assert.equal(saved?.notebookId, "device:notes");
    assert.equal(saved?.bodyMarkdown, "Folder deletion fixture\n\nKeep this document.");
    await page.locator(`.note-preview[data-note-id="${noteId}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Restore note", exact: true }).click();
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("link", { name: "Notes", exact: true }).click();
    await page.locator(`.note-preview[data-note-id="${noteId}"]`).waitFor();
    assert.deepEqual(errors, []);
    console.log(
        "PASS: sidebar context menu, folder header menu, edit name/color, cancel deletion, offline edit/delete, durable trash and restore to Notes"
    );
} catch (error) {
    console.log("Page errors:", errors);
    console.log("Visible errors:", await page.locator(".error-banner,.startup-error").allTextContents());
    await page.screenshot({ path: "/tmp/party-notes-folder-failure.png" });
    throw error;
} finally {
    await context.setOffline(false);
    await browser.close();
    if (await read("Notebook", folderId)) await sdk.actions.deleteNotebook({ notebook: folderId });
    if (await read("Note", noteId)) await sdk.actions.updateNote({ note: noteId, trashed: true });
    await sdk.cleanup();
}
