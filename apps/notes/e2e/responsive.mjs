import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";

const base = process.argv[2];
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const id = crypto.randomUUID();
const testFolder = { id: crypto.randomUUID(), name: `Responsive ${Date.now()}`, color: "#829bbc" };
let folderCreated = false;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function menu() {
    const drawer = page.getByRole("dialog", { name: "Folders", exact: true });
    const trigger = page.getByRole("button", { name: "Open menu", exact: true }).filter({ visible: true });
    if (await trigger.count()) {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
        await drawer.waitFor();
    }
}
async function settledDialog(name) {
    const dialog = page.getByRole("dialog", { name, exact: true });
    await dialog.waitFor();
    await page.waitForFunction((name) => {
        const popup = [...document.querySelectorAll('[role="dialog"]')].find(
            (el) => el.querySelector("h2")?.textContent === name
        );
        return popup && getComputedStyle(popup).opacity === "1" && getComputedStyle(popup).scale === "1";
    }, name);
    return dialog;
}
try {
    await sdk.actions.createNotebook(testFolder);
    folderCreated = true;
    await sdk.actions.createNote({
        id,
        title: "Responsive controls fixture",
        kind: "note",
        notebookId: testFolder.id,
    });
    await page.goto(base);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    for (const name of ["Pinned", "Secure notes", "Logins"])
        assert.equal(await page.getByRole("link", { name, exact: true }).count(), 0);
    await page.getByRole("link", { name: testFolder.name, exact: true }).click();
    assert.equal(
        await page
            .getByRole("link", { name: "Notes", exact: true })
            .locator("svg")
            .evaluate((el) => getComputedStyle(el).color),
        "rgb(233, 189, 69)"
    );
    assert.equal(new URL(page.url()).pathname, `/folders/${testFolder.id}`);
    assert.equal(new URL(page.url()).search, "");
    await page.locator(`.note-preview[data-note-id="${id}"]`).click();
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    assert(new URL(page.url()).pathname.endsWith(`/${testFolder.id}/${id}`));
    const layout = await page.evaluate(() =>
        Object.fromEntries(
            [
                ".note-main",
                ".toolbar-left",
                ".toolbar-middle",
                ".format-toolbar",
                ".toolbar-right",
                ".toolbar-actions",
                ".desktop-search",
            ].map((selector) => {
                const el = document.querySelector(selector),
                    rect = el.getBoundingClientRect();
                return [
                    selector,
                    {
                        x: rect.x,
                        right: rect.right,
                        width: rect.width,
                        display: getComputedStyle(el).display,
                    },
                ];
            })
        )
    );
    console.log("Toolbar layout:", layout);
    assert(
        layout[".format-toolbar"].right <= layout[".toolbar-right"].x,
        "formatting group overlaps right-side controls"
    );
    const pin = page.getByRole("button", { name: "Pin note", exact: true });
    await pin.click();
    const unpin = page.getByRole("button", { name: "Unpin note", exact: true });
    await unpin.waitFor();
    await page.mouse.move(1435, 950);
    await page.waitForFunction(
        () =>
            getComputedStyle(document.querySelector('[aria-label="Unpin note"]')).backgroundColor ===
            "rgba(0, 0, 0, 0)"
    );
    const selectedStyle = await unpin.evaluate((el) => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
        border: getComputedStyle(el).borderWidth,
    }));
    assert.equal(selectedStyle.color, "rgb(233, 189, 69)");
    assert.equal(selectedStyle.background, "rgba(0, 0, 0, 0)");
    assert.equal(selectedStyle.border, "0px");
    await page.screenshot({ path: "/tmp/party-notes-toolbar.png" });
    for (const width of [1440, 1024, 900, 768, 390]) {
        await page.setViewportSize({ width, height: 960 });
        await page.waitForFunction(
            (width) =>
                document.querySelector(".notes-app")?.classList.contains("compact-layout") === width <= 1000,
            width
        );
        const count = await page
            .getByRole("button", { name: "New note", exact: true })
            .filter({ visible: true })
            .count();
        assert.equal(count, width <= 700 ? 0 : 1, `${width}px must not show duplicate New buttons`);
        if (width <= 700) {
            const toolbar = page.locator(".workspace-toolbar");
            const back = toolbar.getByRole("link", { name: "Back to notes", exact: true });
            assert.equal(await back.evaluate((el) => el.classList.contains("active")), false);
            assert.equal(
                await back.evaluate((el) => getComputedStyle(el).borderColor),
                await toolbar
                    .getByRole("button", { name: "Insert into note", exact: true })
                    .evaluate((el) => getComputedStyle(el).borderColor)
            );
            const controls = await toolbar.evaluate((el) => {
                const back = el.querySelector(".back-to-list").getBoundingClientRect();
                const insert = el.querySelector('[aria-label="Insert into note"]').getBoundingClientRect();
                const more = el.querySelector(".toolbar-actions").getBoundingClientRect();
                return {
                    back: back.height,
                    insert: insert.height,
                    more: more.height,
                    gap: more.x - insert.right,
                };
            });
            assert.equal(controls.back, 44);
            assert.equal(controls.insert, 44);
            assert.equal(controls.more, 44);
            assert(controls.gap >= 8);
            assert.equal(
                await toolbar
                    .getByRole("button", { name: "Search notes", exact: true })
                    .filter({ visible: true })
                    .count(),
                0
            );
            assert.equal(
                await toolbar
                    .getByRole("button", { name: "Open menu", exact: true })
                    .filter({ visible: true })
                    .count(),
                0
            );
            assert.equal(
                await toolbar
                    .getByRole("button", { name: "Insert into note", exact: true })
                    .filter({ visible: true })
                    .count(),
                1
            );
            assert.equal(
                await toolbar
                    .getByRole("button", { name: "Note options", exact: true })
                    .filter({ visible: true })
                    .count(),
                1
            );
        }
    }
    await page.screenshot({ path: "/tmp/party-notes-mobile-navbar.png" });
    await page.getByRole("link", { name: "Back to notes", exact: true }).click();
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/folders/${testFolder.id}`);
    assert.equal(
        await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).count(),
        1
    );
    await menu();
    await page.getByRole("link", { name: "Recently deleted", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/trash");
    await page.getByRole("heading", { name: "Recently deleted", exact: true }).waitFor();
    await menu();
    const deleted = page.getByRole("link", { name: "Recently deleted", exact: true });
    assert.equal(await deleted.getAttribute("aria-current"), "page");
    assert.equal(
        await page
            .getByRole("heading", { name: "Recently deleted", exact: true })
            .locator("svg")
            .evaluate((el) => getComputedStyle(el).color),
        await deleted.locator("svg").evaluate((el) => getComputedStyle(el).color)
    );
    await page.getByRole("link", { name: testFolder.name, exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/folders/${testFolder.id}`);
    await menu();
    const drawerSize = await page
        .locator(".sidebar-drawer")
        .evaluate((el) => el.getBoundingClientRect().width);
    assert.equal(drawerSize, 320);
    assert(
        await page
            .getByRole("link", { name: "Recently deleted", exact: true })
            .evaluate((el) => el.getBoundingClientRect().height >= 46)
    );
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const folder = await settledDialog("New folder");
    assert.equal(await page.locator(".dialog-backdrop").filter({ visible: true }).count(), 1);
    assert.equal(await folder.getByText("Color", { exact: true }).count(), 0);
    await folder.getByRole("radio", { name: "Blue", exact: true }).click();
    assert.equal(
        await folder.getByRole("radio", { name: "Blue", exact: true }).getAttribute("aria-checked"),
        "true"
    );
    assert.equal(await folder.getByLabel("Custom folder color", { exact: true }).inputValue(), "#829bbc");
    const cancel = folder.getByRole("button", { name: "Cancel", exact: true });
    const before = await cancel.evaluate((el) => getComputedStyle(el).backgroundColor);
    await cancel.hover();
    await page.waitForFunction(
        (before) =>
            getComputedStyle(document.querySelector(".folder-dialog .dialog-actions button"))
                .backgroundColor !== before,
        before
    );
    await page.screenshot({ path: "/tmp/party-notes-new-folder.png" });
    await folder.getByRole("button", { name: "Close new folder", exact: true }).click();
    await folder.waitFor({ state: "hidden" });
    const closeMenu = page.getByRole("button", { name: "Close menu", exact: true }).filter({ visible: true });
    if (await closeMenu.count()) await closeMenu.click();
    await setFolderDownload(page, true);
    await page.locator(`.note-preview[data-note-id="${id}"]`).click();
    await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
    await page.getByRole("button", { name: "Note options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/folders/${testFolder.id}`);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.locator(`.note-preview[data-note-id="${id}"]`).waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log(
        "PASS: folder routes, cohesive controls, neutral Back border, mobile spacing, dialogs, folder downloads and deletion back to folder"
    );
} catch (error) {
    console.log("Visible state:", await page.locator(".notes-app").getAttribute("class"));
    await page.screenshot({ path: "/tmp/party-notes-responsive-failure.png" });
    throw error;
} finally {
    await browser.close();
    await sdk.actions.updateNote({ note: id, trashed: true });
    if (folderCreated) await sdk.actions.deleteNotebook({ notebook: testFolder.id });
    await sdk.cleanup();
}
