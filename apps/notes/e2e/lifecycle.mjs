// Run against the local preview. Only the note created here is changed/deleted.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
    window.workerOpens = 0;
    const Original = window.SharedWorker;
    window.SharedWorker = class extends Original {
        constructor(...args) {
            super(...args);
            window.workerOpens++;
        }
    };
});
try {
    const opened = Date.now();
    await page.goto(process.argv[2]);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    console.log("Initial list:", Date.now() - opened, "ms");
    await page
        .getByRole("button", { name: "New note", exact: true })
        .filter({ visible: true })
        .first()
        .click();
    const start = Date.now();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Note content", exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    console.log("Create to editable:", Date.now() - start, "ms");
    const title = `Lifecycle audit ${Date.now()}`;
    await editor.pressSequentially(title);
    await editor.press("Enter");
    await page.getByRole("button", { name: "Checklist", exact: true }).filter({ visible: true }).click();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert(
        await page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest("li[data-checked]")),
        "toolbar checklist selection is outside its first item"
    );
    await page.keyboard.type("first task");
    const firstTask = editor.locator('ul[data-type="taskList"] > li').first();
    assert.equal(await firstTask.locator("p").textContent(), "first task");
    assert(
        await firstTask.evaluate((item) => {
            const box = item.querySelector("input").getBoundingClientRect();
            const text = item.querySelector("p").getBoundingClientRect();
            return (
                getComputedStyle(item).display === "flex" &&
                Math.abs(box.y + box.height / 2 - text.y - text.height / 2) < 8
            );
        }),
        "checklist text must appear beside its checkbox"
    );
    await editor.press("Enter");
    await editor.press("Enter");
    await editor.pressSequentially("/checklist");
    await page.getByRole("option", { name: "Checklist", exact: true }).waitFor();
    await editor.press("Enter");
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert(
        await page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest("li[data-checked]")),
        "slash checklist selection is outside its first item"
    );
    await page.keyboard.type("second task");
    await editor.press("Enter");
    await editor.press("Enter");
    await editor.pressSequentially("/");
    const commands = await page
        .getByRole("listbox", { name: "Insert into note", exact: true })
        .getByRole("option")
        .allTextContents();
    assert(commands.indexOf("TypeScript") > commands.indexOf("Checklist"));
    await editor.press("Escape");
    await editor.press("Backspace");
    await page.evaluate(() => {
        window.originalEditor = document.querySelector(".markdown-editor");
        window.initialWorkers = window.workerOpens;
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(35_000);
    await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(100);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(100);
    assert(
        await page.evaluate(() => window.originalEditor === document.querySelector(".markdown-editor")),
        "visibility/motion change remounted the editor"
    );
    assert(
        await page.evaluate(() => window.initialWorkers === window.workerOpens),
        "visibility/motion change reopened the worker"
    );
    await page.getByRole("button", { name: "Hide folders", exact: true }).click();
    await page.getByRole("button", { name: "Show folders", exact: true }).filter({ visible: true }).click();
    assert(
        await page.evaluate(() => window.originalEditor === document.querySelector(".markdown-editor")),
        "sidebar transition remounted the editor"
    );
    const divider = page.getByRole("separator", { name: "Resize folders", exact: true });
    const originalWidth = Number(await divider.getAttribute("aria-valuenow"));
    const rect = await divider.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 25.375, 300, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    assert.equal(
        await page.getByText("Mutation does not match the object definition.", { exact: true }).count(),
        0
    );
    const savedWidth = await divider.getAttribute("aria-valuenow");
    const reloadStart = Date.now();
    await page.reload();
    await editor.waitFor();
    assert.equal(await divider.getAttribute("aria-valuenow"), savedWidth);
    await page.waitForFunction(
        (title) => document.querySelector(".markdown-editor > p")?.textContent === title,
        title
    );
    console.log("Refresh to note content:", Date.now() - reloadStart, "ms");
    const restored = await divider.boundingBox();
    await page.mouse.move(restored.x + restored.width / 2, 300);
    await page.mouse.down();
    await page.mouse.move(restored.x + restored.width / 2 + originalWidth - Number(savedWidth), 300);
    await page.mouse.up();
    await page.screenshot({ path: "/tmp/party-notes-lifecycle-final.png" });
    const card = page.getByRole("option", { name: new RegExp(`^${title} `) });
    await card.focus();
    await card.press("Backspace");
    await card.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(
        "PASS: stable visibility/motion lifecycle, checklist focus, slash order, fractional resize persistence"
    );
} catch (error) {
    console.error("Page errors:", errors);
    await page.screenshot({ path: "/tmp/party-notes-lifecycle-failure.png" });
    throw error;
} finally {
    await browser.close();
}
