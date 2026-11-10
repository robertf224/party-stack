import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const channel = process.env.PARTY_BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch({ channel });
console.log("Browser:", browser.version(), channel);
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const errors = [];
const states = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
    await page.goto(new URL("/", base).href);
    const rows = page.locator(".note-list .note-preview");
    await rows.first().waitFor();
    const firstId = await rows.first().getAttribute("data-note-id");
    const folder = page.getByRole("link", { name: "Notes", exact: true });
    if (!(await folder.isVisible()))
        await page.getByRole("button", { name: "Show folders", exact: true }).click();
    const focusedId = () => page.evaluate(() => document.activeElement?.getAttribute("data-note-id"));
    const openNote = async (id, stage) => {
        await page.waitForURL((url) => decodeURIComponent(url.pathname) === `/notes/${id}`);
        await page.locator(`.note-page[data-note-id="${id}"]`).waitFor();
        assert.equal(await focusedId(), id, "Opening a note from the list must keep list focus");
        assert.equal(
            await page.locator(`.note-preview[data-note-id="${id}"]`).getAttribute("aria-selected"),
            "true"
        );
        states.push({ stage, url: page.url(), focusedNote: await focusedId() });
    };

    // No selected note exists on the folder route. Entering its list must open
    // the focused preview, rather than merely painting a focus highlight.
    await folder.focus();
    await page.keyboard.press("ArrowRight");
    await openNote(firstId, "folder-to-first-note");

    const hasSecond = (await rows.count()) > 1;
    const selectedId = hasSecond ? await rows.nth(1).getAttribute("data-note-id") : firstId;
    if (hasSecond) {
        await page.keyboard.press("ArrowDown");
        await openNote(selectedId, "list-down");
    }
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Notes");
    await page.keyboard.press("ArrowRight");
    await openNote(selectedId, "folder-to-existing-selection");
    if (hasSecond) {
        await page.keyboard.press("ArrowUp");
        await openNote(firstId, "list-up");
    }

    // Editor focus remains an explicit second ArrowRight from the note list.
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() =>
        ["Note content", "Note title"].includes(document.activeElement?.getAttribute("aria-label"))
    );
    states.push({
        stage: "list-to-editor",
        url: page.url(),
        editorFocus: await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    });
    assert.deepEqual(errors, []);
    console.log("PASS: read-only folder/list/editor keyboard navigation", JSON.stringify(states));
} finally {
    await browser.close();
}
