import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { eq, field } from "@party-stack/ontology-storage/tables";
import { httpClient } from "@party-stack/ontology/http";
import { Effect } from "effect";
import { chromium } from "playwright";

const base = process.argv[2];
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const ids = [crypto.randomUUID(), crypto.randomUUID()];
const attachmentId = crypto.randomUUID();
let attachmentCreated = false;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const editor = page.getByRole("textbox", { name: "Note content", exact: true });
async function persisted(id, title) {
    const deadline = Date.now() + 10_000;
    let last;
    do {
        // Read the authority explicitly; queryOnce over the fixture SDK may
        // legitimately return its own already-cached copy of the created row.
        const note = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* httpClient("http://127.0.0.1:5173/api/ontology/rpc");
                    const remote = yield* client.ontology();
                    const snapshot = yield* remote.backend.loadSubset(
                        objectSubset("Note", { where: eq(field("id"), id) })
                    );
                    return snapshot.rows[0]?.value;
                })
            )
        );
        last = note;
        if (note?.title === title && typeof note.bodyMarkdown === "string" && note.bodyMarkdown)
            return { ...note, bodyMarkdown: note.bodyMarkdown };
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    console.log("Document at timeout:", last);
    console.log("Editor at timeout:", await editor.innerHTML());
    console.log("Page errors:", errors);
    console.log("Alerts:", await page.getByRole("alert").allTextContents());
    console.log("Local preview:", await page.locator(`.note-preview[data-note-id="${id}"]`).innerText());
    await page.getByRole("button", { name: "Open TanStack Devtools", exact: true }).click();
    await page.getByRole("tab", { name: /Outbox/ }).click();
    console.log("Outbox:", await page.getByRole("tabpanel").allTextContents());
    throw new Error("The edited document did not reach the owned backend.");
}
try {
    for (const id of ids)
        await sdk.actions.createNote({ id, title: "", kind: "note", notebookId: "device:personal" });
    await page.goto(new URL(`/notes/${ids[0]}`, base).href);
    await editor.waitFor();
    assert.equal(await editor.locator("[data-placeholder]").count(), 0);
    await editor.click();
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    await page.keyboard.type("A first line with formatting");
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    await page.keyboard.press("Enter");
    await page.keyboard.type("The entire note is one Markdown document.");
    await page.getByRole("textbox", { name: "Search notes", exact: true }).filter({ visible: true }).click();
    const note = await persisted(ids[0], "A first line with formatting");
    assert(note.bodyMarkdown.startsWith("**A first line with formatting**"));
    assert(note.bodyMarkdown.includes("The entire note is one Markdown document."));
    await page.reload();
    await editor.locator("p > strong").getByText("A first line with formatting", { exact: true }).waitFor();
    assert.equal(await editor.locator(":scope > p").count(), 2);
    const styles = await page.evaluate(() => {
        const content = document.querySelector(".markdown-editor");
        const paragraphs = content.querySelectorAll(":scope > p");
        return {
            paragraphs: [...paragraphs].map((p) => [
                getComputedStyle(p).fontSize,
                getComputedStyle(p).marginBottom,
            ]),
            editorCaret: getComputedStyle(content).caretColor,
            searchCaret: getComputedStyle(document.querySelector(".desktop-search input")).caretColor,
            list: getComputedStyle(document.querySelector(".note-list")).backgroundColor,
            main: getComputedStyle(document.querySelector(".note-main")).backgroundColor,
        };
    });
    assert.deepEqual(styles.paragraphs[0], styles.paragraphs[1]);
    assert.equal(styles.editorCaret, "rgb(233, 189, 69)");
    assert.equal(styles.searchCaret, styles.editorCaret);
    assert.equal(styles.list, "rgb(36, 41, 44)");
    assert.equal(styles.main, "rgb(30, 30, 30)");
    await page.locator(`.note-preview[data-note-id="${ids[0]}"]`).click({ button: "right" });
    const menu = page.getByRole("menu");
    const deleteColor = await menu
        .getByRole("menuitem", { name: "Delete note", exact: true })
        .evaluate((el) => getComputedStyle(el).color);
    const normalColor = await menu
        .getByRole("menuitem", { name: "Duplicate note", exact: true })
        .evaluate((el) => getComputedStyle(el).color);
    assert.equal(deleteColor, normalColor);
    await page.screenshot({ path: "/tmp/party-notes-native-document.png" });
    await page.keyboard.press("Escape");

    const { attachment } = await sdk.attachments.create(
        new File(["A file attachment"], "document-test.txt", { type: "text/plain" }),
        { target: { kind: "actionParameter", actionType: "addAttachment", parameter: "file" } }
    );
    await sdk.actions.addAttachment({ id: attachmentId, noteId: ids[0], file: attachment });
    attachmentCreated = true;
    await sdk.actions.updateNote({
        note: ids[0],
        bodyMarkdown: `${note.bodyMarkdown}\n\n![document-test.txt](attachment:${attachmentId})`,
    });
    const card = page.getByRole("group", { name: "Attachment: document-test.txt", exact: true });
    await card.waitFor();
    await card.focus();
    const selected = editor.locator(".node-image.ProseMirror-selectednode");
    await selected.waitFor();
    assert(Math.abs((await selected.boundingBox()).width - (await card.boundingBox()).width) < 2);
    await page.screenshot({ path: "/tmp/party-notes-attachment-focus.png" });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    await page.keyboard.type("Continue after the attachment");
    assert.equal(await editor.locator(".node-image + p").textContent(), "Continue after the attachment");

    await page.goto(new URL(`/notes/${ids[1]}`, base).href);
    await editor.waitFor();
    await editor.click();
    await page.keyboard.type("/checklist");
    await page.getByRole("option", { name: "Checklist", exact: true }).click();
    await page.keyboard.type("A checklist can be the first line");
    assert.equal(await editor.locator(":scope > ul[data-type=taskList]").count(), 1);
    assert.equal(await editor.locator(":scope > :first-child").evaluate((el) => el.tagName), "UL");
    await page.getByRole("textbox", { name: "Search notes", exact: true }).filter({ visible: true }).click();
    const checklist = await persisted(ids[1], "A checklist can be the first line");
    assert(checklist.bodyMarkdown.includes("- [ ] A checklist can be the first line"));
    await page.reload();
    await editor
        .locator("ul[data-type=taskList] p")
        .getByText("A checklist can be the first line", { exact: true })
        .waitFor();
    assert.deepEqual(errors, []);
    console.log(
        "PASS: complete Markdown roundtrip, derived first-line title, unrestricted first block, normal menu colors and yellow carets"
    );
} finally {
    await browser.close();
    if (attachmentCreated) await sdk.actions.removeAttachment({ attachment: attachmentId });
    for (const note of ids) await sdk.actions.updateNote({ note, trashed: true });
    await sdk.cleanup();
}
