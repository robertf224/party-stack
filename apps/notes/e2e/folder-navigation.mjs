import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const base = process.argv[2];
const baseline = process.argv.includes("--baseline");
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const fixtures = ["A", "B"].map((name) => ({
    folder: crypto.randomUUID(),
    note: crypto.randomUUID(),
    name: `Navigation ${name}`,
}));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
    for (const fixture of fixtures) {
        await sdk.actions.createNotebook({ id: fixture.folder, name: fixture.name, color: "#829bbc" });
        await sdk.actions.createNote({
            id: fixture.note,
            notebookId: fixture.folder,
            title: fixture.name,
            kind: "note",
        });
    }
    await page.goto(base);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.evaluate((fixtures) => {
        window.folderNavigation = { samples: [], pending: undefined };
        document.addEventListener(
            "click",
            (event) => {
                const link = event.target.closest?.(".nav-item");
                const fixture = fixtures.find((row) => link?.getAttribute("href")?.endsWith(row.folder));
                if (fixture)
                    window.folderNavigation.pending = { fixture, at: performance.now(), staleFrames: 0 };
            },
            true
        );
        const tick = () => {
            const pending = window.folderNavigation.pending;
            if (pending) {
                const heading = document.querySelector(".list-heading h1")?.textContent;
                if (heading?.includes(pending.fixture.name) && pending.heading === undefined)
                    pending.heading = performance.now() - pending.at;
                const list = document.querySelector('.entries[role="listbox"]');
                const target = list?.querySelector(`[data-note-id="${pending.fixture.note}"]`);
                const visible = (node) =>
                    node.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
                const hasTarget = target && visible(target);
                if (
                    document
                        .querySelector('.nav-item[aria-current="page"]')
                        ?.getAttribute("href")
                        ?.endsWith(pending.fixture.folder) &&
                    list &&
                    !hasTarget &&
                    [...list.querySelectorAll(".note-preview")].some(visible)
                )
                    pending.staleFrames++;
                if (hasTarget) {
                    window.folderNavigation.samples.push({
                        headingMs: pending.heading,
                        listMs: performance.now() - pending.at,
                        staleFrames: pending.staleFrames,
                    });
                    window.folderNavigation.pending = undefined;
                }
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, fixtures);
    for (let i = 0; i < 6; i++) {
        const fixture = fixtures[i % 2];
        await page.getByRole("link", { name: fixture.name, exact: true }).click();
        await page.locator(`.note-preview[data-note-id="${fixture.note}"]`).waitFor();
        await page.waitForFunction((count) => window.folderNavigation.samples.length === count, i + 1);
    }
    const samples = await page.evaluate(() => window.folderNavigation.samples);
    console.log("Folder click-to-display timings:", JSON.stringify(samples));
    await writeFile(
        `/tmp/party-folder-nav-${baseline ? "baseline" : "updated"}.json`,
        JSON.stringify(samples, null, 2)
    );
    if (!baseline)
        assert(
            samples.every((sample) => sample.staleFrames === 0),
            "A previous folder remained visible after selection"
        );
    assert.deepEqual(errors, []);
    // A deleted/unknown parent must finish boot as an empty view, rather than
    // waiting forever for a child fragment that can never exist.
    await page.goto(new URL(`/folders/${crypto.randomUUID()}`, base).href);
    await page.getByText("This folder isn’t available.", { exact: true }).waitFor();
    assert.equal(
        await page.locator(".boot-workspace").evaluate((element) => getComputedStyle(element).visibility),
        "visible"
    );
    assert.equal(await page.getByRole("button", { name: "Download folder", exact: true }).count(), 0);
} finally {
    await browser.close();
    for (const fixture of fixtures) await sdk.actions.deleteNotebook({ notebook: fixture.folder });
    await sdk.cleanup();
}
