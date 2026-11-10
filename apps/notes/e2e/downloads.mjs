import assert from "node:assert/strict";

/** Exercise the public folder control, including its normal optimistic status. */
export async function setFolderDownload(page, enabled, { wait = true } = {}) {
    const control = page.locator(".list-heading .folder-download").filter({ visible: true });
    await control.waitFor();
    const button = control.getByRole("button");
    if ((await button.getAttribute("aria-pressed")) !== String(enabled)) await button.click();
    await page.waitForFunction(
        (enabled) =>
            [...document.querySelectorAll(".list-heading .folder-download button")].some(
                (button) =>
                    button.getClientRects().length && button.getAttribute("aria-pressed") === String(enabled)
            ),
        enabled
    );
    if (wait && enabled) {
        await control
            .locator("..")
            .locator('.folder-download[data-status="ready"], .folder-download[data-status="failed"]')
            .waitFor({ timeout: 60_000 });
        assert.equal(await control.getAttribute("data-status"), "ready", await button.getAttribute("title"));
    }
}
