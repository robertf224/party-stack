// Verify preferences use the Notes outbox and sidebar shortcuts preserve editor Bold.
import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { queryOnce } from "@tanstack/db";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL and optional local RPC URL.");
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? "http://127.0.0.1:5173/api/ontology/rpc"),
});
const [original] = await queryOnce((q) => q.from({ preferences: sdk.objects.Preferences }));
assert(original, "Preferences must be in the Notes ontology");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
    await page.goto(base);
    const divider = page.getByRole("separator", { name: "Resize folders", exact: true });
    await divider.waitFor();
    await page.keyboard.press("Meta+j");
    await page.getByRole("button", { name: "Show folders", exact: true }).waitFor();
    await page.keyboard.press("Meta+j");
    await page.getByRole("button", { name: "Hide folders", exact: true }).waitFor();
    console.log("Sidebar shortcut passed; opening outbox");
    await page.getByRole("button", { name: "Open TanStack Devtools", exact: true }).click();
    await page.getByRole("tab", { name: /Outbox/ }).click();
    await context.setOffline(true);
    const start = Number(await divider.getAttribute("aria-valuenow"));
    const delta = start > 300 ? -20.375 : 20.375;
    const expected = Math.round(start + delta);
    const rect = await divider.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, 160);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + delta, 160, { steps: 5 });
    await page.mouse.up();
    await page.getByText("setPanelWidths", { exact: true }).waitFor();
    console.log("setPanelWidths is visible in the Notes outbox while offline");
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), expected);
    await page.screenshot({ path: "/tmp/party-notes-preferences-outbox.png" });
    await context.setOffline(false);
    await page.getByText("setPanelWidths", { exact: true }).waitFor({ state: "hidden" });
    // The tab may be acknowledged by its worker before the worker reaches the
    // owned backend. Observe the server before restoring preferences in finally.
    const deadline = Date.now() + 10_000;
    let persisted;
    do {
        [persisted] = await queryOnce((q) => q.from({ preferences: sdk.objects.Preferences }));
        if (persisted.foldersWidth === expected) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(persisted.foldersWidth, expected);
    await page.reload();
    await divider.waitFor();
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), expected);

    console.log("Resize persisted after reconnect and reload");
    // The sidebar shortcut works from the editor without capturing Cmd+B.
    await page.goto(new URL("/notes/ada%3Aproject", base).href);
    const editor = page.getByRole("textbox", { name: "Note content", exact: true });
    await editor.locator("p").first().click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Note content");
    await page.keyboard.press("Meta+b");
    assert(await page.getByRole("button", { name: "Hide folders", exact: true }).isVisible());
    await page.keyboard.press("Meta+b");
    await page.keyboard.press("Meta+j");
    await page.getByRole("button", { name: "Show folders", exact: true }).waitFor();
    await page.keyboard.press("Meta+j");
    await page.getByRole("button", { name: "Hide folders", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Control+j");
    const menu = page.getByRole("dialog", { name: "Folders", exact: true });
    await menu.waitFor();
    await page.keyboard.press("Control+j");
    await menu.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log(
        "PASS: same-ontology resize outbox, offline/reload persistence, desktop/mobile sidebar shortcut, Cmd+B leaves sidebar alone"
    );
} catch (error) {
    console.error("Page errors:", errors, "URL:", page.url());
    await page.screenshot({ path: "/tmp/party-notes-preferences-failure.png" });
    throw error;
} finally {
    await context.setOffline(false);
    await browser.close();
    await sdk.actions.setPanelWidths({
        preferences: original.id,
        foldersWidth: original.foldersWidth,
        notesWidth: original.notesWidth,
    });
    await sdk.cleanup();
}
