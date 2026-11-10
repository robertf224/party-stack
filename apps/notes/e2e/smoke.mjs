// Manual UI/data regression check against the local Notes preview.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL printed by Vite.");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const title = `UI audit ${Date.now()}`;
await page.addInitScript(() => {
    window.bootFrames = { started: false, blank: 0 };
    const frame = () => {
        const splash = document.querySelector(".opening");
        const workspace = document.querySelector(".boot-workspace");
        const ready = workspace && getComputedStyle(workspace).visibility === "visible";
        if (splash) window.bootFrames.started = true;
        if (window.bootFrames.started && !splash && !ready) window.bootFrames.blank++;
        if (!ready) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
});
try {
    await page.goto(base);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Notes", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.bootFrames.blank), 0);
    const divider = page.getByRole("separator", { name: "Resize folders", exact: true });
    const width = Number(await divider.getAttribute("aria-valuenow"));
    await divider.press("ArrowRight");
    await page.waitForFunction(
        (width) =>
            document.querySelector("[aria-label='Resize folders']")?.getAttribute("aria-valuenow") ===
            String(width + 10),
        width
    );
    await page.getByRole("button", { name: "Hide folders", exact: true }).click();
    await page.locator(".note-list").getByRole("button", { name: "Show folders", exact: true }).click();
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), width + 10);
    // A second tab reads the same persisted preference, with its own open state.
    const sibling = await context.newPage();
    sibling.on("pageerror", (error) => errors.push(error.message));
    await sibling.goto(base);
    await sibling.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await sibling.waitForFunction(
        (width) =>
            document.querySelector("[aria-label='Resize folders']")?.getAttribute("aria-valuenow") ===
            String(width + 10),
        width
    );
    await sibling.close();
    await divider.press("ArrowLeft");
    // Dragging to the left stops at the minimum; it cannot close the pane.
    const handle = await divider.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(0, 300, { steps: 8 });
    await page.mouse.up();
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), 208);
    await divider.dblclick();
    await page
        .getByRole("button", { name: "New note", exact: true })
        .filter({ visible: true })
        .first()
        .click();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Note content", exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    await editor.pressSequentially(title);
    await editor.press("Enter");
    await editor.pressSequentially("A note with a code snippet and an attachment.");
    await editor.press("Enter");
    await editor.pressSequentially("/typescript");
    const commands = page.getByRole("listbox", { name: "Insert into note", exact: true });
    await commands.getByRole("option", { name: "TypeScript", exact: true }).waitFor();
    await editor.press("Enter");
    await page.getByRole("combobox", { name: "Code language", exact: true }).waitFor();
    await page.locator("[data-node-view-content]").last().fill("const answer: number = 42;");
    assert.equal(await page.getByRole("textbox", { name: "Note title", exact: true }).count(), 0);
    await page.getByRole("combobox", { name: "Code language", exact: true }).click();
    await page.getByRole("option", { name: "JSON", exact: true }).waitFor();
    const choices = await page.getByRole("option").filter({ visible: true }).allTextContents();
    assert(
        choices.includes("Rust") &&
            choices.includes("HTML") &&
            choices.includes("JSON") &&
            choices.includes("TypeScript")
    );
    assert(!choices.includes("Python") && !choices.includes("JavaScript"));
    await page.getByRole("option", { name: "TypeScript", exact: true }).click();
    const transfer = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.items.add(new File(["embedded bytes"], "ui-audit.txt", { type: "text/plain" }));
        return data;
    });
    await editor.dispatchEvent("drop", { dataTransfer: transfer, clientX: 900, clientY: 500 });
    await page.getByRole("link", { name: /ui-audit.txt/ }).waitFor();
    const firstLine = await editor.locator("p").first().boundingBox();
    const attachmentBlock = await page.locator(".document-attachment").last().boundingBox();
    await page.mouse.move(firstLine.x + 2, firstLine.y + firstLine.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        attachmentBlock.x + attachmentBlock.width - 2,
        attachmentBlock.y + attachmentBlock.height + 6,
        { steps: 20 }
    );
    await page.mouse.up();
    assert(
        (await page.locator(".block-in-selection").count()) >= 2,
        "drag selection skipped code or attachments"
    );
    await editor.press("ControlOrMeta+a");
    assert(
        (await page.locator(".block-in-selection").count()) >= 2,
        "code and attachments were not highlighted as part of the selection"
    );
    await editor.press("ArrowRight");
    await page.getByRole("textbox", { name: "Search notes", exact: true }).filter({ visible: true }).click();
    await page.waitForTimeout(800);
    const url = page.url();
    await page.reload();
    await page.waitForFunction(
        (title) => document.querySelector(".markdown-editor > :first-child")?.textContent === title,
        title
    );
    await page.getByRole("link", { name: /ui-audit.txt/ }).waitFor();
    assert((await page.locator(".hljs-keyword").count()) > 0);
    const heights = await page.evaluate(() =>
        [
            ".toolbar-left .glass-button",
            ".desktop-search",
            ".desktop-format .format-toolbar",
            ".toolbar-actions",
        ].map((selector) => document.querySelector(selector).getBoundingClientRect().height)
    );
    assert(
        heights.every((height) => Math.abs(height - 35) < 1),
        `toolbar heights differ: ${heights}`
    );
    await page.getByRole("textbox", { name: "Search notes", exact: true }).filter({ visible: true }).click();
    assert.match(
        await page.locator(".desktop-search").evaluate((element) => getComputedStyle(element).outlineColor),
        /213, 166, 43/
    );
    await page.keyboard.press("Escape");
    await page.evaluate(() =>
        Promise.all(
            document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .map((animation) => animation.finished.catch(() => {}))
        )
    );
    await page.screenshot({ path: "/tmp/party-notes-desktop.png" });
    const restored = await divider.boundingBox();
    const currentWidth = Number(await divider.getAttribute("aria-valuenow"));
    await page.mouse.move(restored.x + restored.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(restored.x + restored.width / 2 + width - currentWidth, 300);
    await page.mouse.up();
    const card = page.getByRole("option", { name: new RegExp(`^${title} `) });
    await card.focus();
    await card.press("Backspace");
    await card.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: "Back to notes", exact: true }).click();
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open menu", exact: true }).filter({ visible: true }).click();
    await page.getByRole("link", { name: "Recently deleted", exact: true }).click();
    await page.getByRole("heading", { name: "Recently deleted", exact: true }).waitFor();
    await page.locator(".list-skeleton").waitFor({ state: "hidden" });
    await page.getByRole("dialog", { name: "Folders", exact: true }).waitFor({ state: "hidden" });
    assert.equal(
        await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).count(),
        0
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: "/tmp/party-notes-mobile.png" });
    assert.deepEqual(errors, []);
    console.log(
        "PASS: title editing, slash commands, language choices, selection highlights, attachments, preferences, drag minimums, keyboard deletion and mobile layout"
    );
} catch (error) {
    console.error("Page errors:", errors);
    await page.screenshot({ path: "/tmp/party-notes-ui-failure.png" });
    throw error;
} finally {
    await browser.close();
}
