// Exercise React row transitions through ordinary live-query updates.
import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
await page.addInitScript(() => {
    const warn = console.warn;
    console.warn = (...args) => warn(...args, new Error("Warning origin").stack);
});
const folder = crypto.randomUUID();
const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
    if (message.type() === "warning") console.log("Browser warning:", message.text());
});
let created = false;
try {
    await sdk.actions.createNotebook({ id: folder, name: "Row transitions", color: "#829bbc" });
    created = true;
    for (const [index, id] of ids.entries())
        await sdk.actions.createNote({ id, notebookId: folder, kind: "note", title: `Transition ${index}` });
    await page.goto(new URL(`/folders/${folder}`, base).href);
    await page.locator(".note-preview").nth(2).waitFor();
    await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(
            document
                .getAnimations()
                .filter((animation) => animation.effect?.pseudoElement?.startsWith("::view-transition-"))
                .map((animation) => animation.finished.catch(() => {}))
        );
    });
    await page.evaluate(() => {
        window.rowAnimations = [];
        window.allAnimations = [];
        const seen = new WeakSet();
        const observe = () => {
            for (const animation of document.getAnimations()) {
                const pseudo = animation.effect?.pseudoElement;
                if (!seen.has(animation))
                    window.allAnimations.push({
                        name: animation.animationName,
                        pseudo,
                        target: String(animation.effect?.target),
                        frames: animation.effect?.getKeyframes(),
                    });
                if (seen.has(animation)) continue;
                seen.add(animation);
                if (!pseudo?.startsWith("::view-transition-group(notes-row-")) continue;
                window.rowAnimations.push({
                    pseudo,
                    frames: animation.effect.getKeyframes(),
                    duration: animation.effect.getTiming().duration,
                });
            }
            window.rowAnimationFrame = requestAnimationFrame(observe);
        };
        observe();
    });
    const before = await page
        .locator(".note-preview")
        .evaluateAll((rows) => rows.map((row) => row.dataset.noteId));
    const moved = before.at(-1);
    const row = page.locator(`.note-preview[data-note-id="${moved}"]`);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin note", exact: true }).click();
    await page.waitForFunction((id) => document.querySelector(".note-preview")?.dataset.noteId === id, moved);
    await page
        .waitForFunction(
            () =>
                window.rowAnimations.some(({ frames }) => frames[0]?.transform !== frames.at(-1)?.transform),
            undefined,
            { timeout: 5000 }
        )
        .catch(async (error) => {
            console.log("Animations:", JSON.stringify(await page.evaluate(() => window.allAnimations)));
            throw error;
        });
    const animations = await page.evaluate(() => window.rowAnimations);
    assert(animations.length > 0, "Row movement must use an actual ViewTransition animation");
    for (const { frames } of animations) {
        if (frames[0]?.width && frames.at(-1)?.width)
            assert.equal(frames[0].width, frames.at(-1).width, "Cards should move without width scaling");
    }
    console.log(
        "PASS: pinning moves live note rows through React ViewTransition",
        JSON.stringify(animations)
    );
    await row.focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("note-preview")), true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
        window.rowAnimations.length = 0;
    });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin note", exact: true }).click();
    await page.waitForFunction(
        (id) =>
            !document.querySelector(
                `.date-section[data-date-group="Pinned"] .note-preview[data-note-id="${id}"]`
            ),
        moved
    );
    // Let the browser finish the update before checking that reduced motion disabled it.
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(
        await page.evaluate(
            () =>
                window.rowAnimations.filter(
                    ({ frames, duration }) =>
                        duration > 0 && frames[0]?.transform !== frames.at(-1)?.transform
                ).length
        ),
        0
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const deleted = await page.locator(".note-preview").first().getAttribute("data-note-id");
    await page.locator(`.note-preview[data-note-id="${deleted}"]`).click();
    await page.locator(`.note-page[data-note-id="${deleted}"]`).waitFor();
    await page.locator(`.note-preview[data-note-id="${deleted}"]`).focus();
    await page.evaluate(() => {
        window.rowAnimations.length = 0;
    });
    await page.keyboard.press("Backspace");
    await page.locator(`.note-preview[data-note-id="${deleted}"]`).waitFor({ state: "hidden" });
    await page.waitForFunction(() =>
        window.rowAnimations.some(({ frames }) => frames[0]?.transform !== frames.at(-1)?.transform)
    );
    console.log("PASS: deleting a note slides remaining rows into place");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Row transitions"
    );
    const activeFolder = await page.evaluate(() => getComputedStyle(document.activeElement).backgroundColor);
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("note-preview")), true);
    const inactiveFolder = await page
        .getByRole("link", { name: "Row transitions", exact: true })
        .evaluate((link) => getComputedStyle(link).backgroundColor);
    assert.notEqual(activeFolder, inactiveFolder);
    const previousUrl = page.url();
    await page.keyboard.press("Shift+N");
    await page.waitForURL((url) => url.href !== previousUrl);
    const editor = page.locator('.note-document [aria-label="Note content"]');
    await editor.waitFor();
    await editor.focus();
    const createdUrl = page.url();
    await page.keyboard.press("Shift+N");
    assert.equal(page.url(), createdUrl);
    console.log(
        "PASS: keyboard navigation crosses panels, inactive folders dim, and Shift+N creates only outside the editor"
    );
    assert.deepEqual(errors, []);
    console.log("PASS: keyboard focus stays in the list and reduced motion skips row animations");
} finally {
    await browser.close();
    if (created) await sdk.actions.deleteNotebook({ notebook: folder });
    await sdk.cleanup();
}
