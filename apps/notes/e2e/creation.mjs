import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const errors = [];
let createdId;
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (msg) => {
    if (msg.type() === "error") console.log("Console error:", msg.text());
});
await page.addInitScript(() => {
    window.timeline = [];
    const record = (data, direction) => {
        if (Array.isArray(data)) for (const value of data) record(value, direction);
        else if (data && typeof data === "object" && "_tag" in data)
            window.timeline.push({
                at: performance.now(),
                direction,
                tag: data._tag,
                operation: data.tag,
                action: data.payload?.invocation?.name,
                invocation: data.payload?.invocation?.id,
                id: data.id ?? data.requestId,
            });
    };
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
        record(args[0], "send");
        return send.apply(this, args);
    };
    const Worker = SharedWorker;
    window.SharedWorker = class extends Worker {
        constructor(...args) {
            super(...args);
            this.port.addEventListener("message", (event) => record(event.data, "receive"));
        }
    };
    document.addEventListener(
        "click",
        (event) => {
            if (event.target.closest?.('[role="menuitem"]')?.textContent.trim() === "Note") {
                window.creationStart = performance.now();
                window.timeline = [];
            }
        },
        true
    );
});
try {
    await page.goto(new URL("/notes/ada%3Aproject", process.argv[2]).href);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    await context.setOffline(true);
    await page
        .getByRole("button", { name: "New note", exact: true })
        .filter({ visible: true })
        .first()
        .click();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    await page.waitForURL(
        (url) =>
            url.pathname.startsWith("/notes/") &&
            decodeURIComponent(url.pathname.split("/").at(-1)) !== "ada:project"
    );
    createdId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1));
    const editor = page
        .locator(`.note-page[data-note-id="${createdId}"]`)
        .getByRole("textbox", { name: "Note content", exact: true });
    await editor.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    console.log(
        "Offline click to editable:",
        await page.evaluate(() => Math.round(performance.now() - window.creationStart)),
        "ms"
    );
    console.log(
        "RPC timeline:",
        await page.evaluate(() =>
            window.timeline.map((item) => ({ ...item, at: Math.round(item.at - window.creationStart) }))
        )
    );
    const title = `Offline creation audit ${Date.now()}`;
    await editor.pressSequentially(title);
    await editor.press("Enter");
    await editor.pressSequentially("Created and edited before any upstream acknowledgement.");
    await page.getByRole("textbox", { name: "Search notes", exact: true }).filter({ visible: true }).click();
    await page.getByRole("option", { name: new RegExp(`^${title} `) }).waitFor();
    await context.setOffline(false);
    await page.waitForTimeout(1000);
    console.log(
        "Before reload timeline:",
        await page.evaluate(() =>
            window.timeline
                .filter((x) => x.tag === "Request")
                .map((item) => ({ ...item, at: Math.round(item.at - window.creationStart) }))
        )
    );
    console.log("Reloading own note:", createdId, title);
    await page.reload();
    await editor.waitFor();
    await page.waitForFunction(
        (title) => document.querySelector(".markdown-editor > p")?.textContent === title,
        title
    );
    const card = page.getByRole("option", { name: new RegExp(`^${title} `) });
    await card.focus();
    await card.press("Backspace");
    await card.waitFor({ state: "hidden" });
    createdId = undefined;
    assert.deepEqual(errors, []);
    console.log("PASS: create and edit offline, then reconnect and reload");
} catch (error) {
    console.log(
        "Failed RPC timeline:",
        await page.evaluate(() =>
            window.timeline.map((item) => ({ ...item, at: Math.round(item.at - window.creationStart) }))
        )
    );
    console.log("Errors:", errors);
    await page.screenshot({ path: "/tmp/party-notes-creation-failure.png" });
    throw error;
} finally {
    await context.setOffline(false);
    if (createdId && decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)) === createdId) {
        const remove = page.getByRole("button", { name: "Move to recently deleted", exact: true });
        if (await remove.isVisible()) await remove.click();
    }
    await browser.close();
}
