// Read-only navigation correctness and timing against the local preview.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
    await page.goto(process.argv[2]);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.evaluate(() => {
        window.notesNavigation = { fallbacks: 0, start: 0, loading: [], mismatches: [] };
        const sample = () => {
            const match = location.pathname.match(/^\/notes\/([^/]+)/);
            if (match) {
                const id = decodeURIComponent(match[1]);
                for (const editor of document.querySelectorAll(".note-page[data-note-id]"))
                    if (
                        editor.getClientRects().length &&
                        getComputedStyle(editor).visibility === "visible" &&
                        editor.dataset.noteId !== id
                    )
                        window.notesNavigation.mismatches.push({
                            expected: id,
                            shown: editor.dataset.noteId,
                        });
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        document.addEventListener(
            "click",
            (event) => {
                if (event.target.closest?.(".note-preview,.nav-item"))
                    window.notesNavigation.start = performance.now();
            },
            true
        );
        new MutationObserver((records) => {
            for (const record of records)
                for (const node of record.addedNodes)
                    if (
                        node instanceof Element &&
                        (node.matches(".editor-loading,.list-skeleton") ||
                            node.querySelector(".editor-loading,.list-skeleton"))
                    ) {
                        window.notesNavigation.fallbacks++;
                        window.notesNavigation.loading.push({
                            path: location.pathname + location.search,
                            className: node.className,
                        });
                    }
        }).observe(document.querySelector(".notes-app"), { subtree: true, childList: true });
    });
    for (const title of ["Project notes", "Things worth making", "Project notes", "Things worth making"]) {
        await page
            .getByRole("option", { name: new RegExp(`^${title} `) })
            .first()
            .click();
        const duration = await page.evaluate(
            (title) =>
                new Promise((resolve) => {
                    const check = () => {
                        if (document.querySelector(".markdown-editor > :first-child")?.textContent === title)
                            resolve(Math.round(performance.now() - window.notesNavigation.start));
                        else requestAnimationFrame(check);
                    };
                    check();
                }),
            title
        );
        console.log(`${title}: ${duration}ms from click to editor`);
        if (title === "Project notes" && !(await page.evaluate(() => window.notesNavigation.firstRead))) {
            // Record warm navigation separately. A new route-owned fragment can
            // initialize asynchronously even when its source row is cached.
            await page.evaluate(() => {
                window.notesNavigation.firstRead = true;
                window.notesNavigation.fallbacks = 0;
                window.notesNavigation.loading = [];
            });
        }
    }
    for (const name of ["Work", "Personal", "Notes", "Work", "Notes"])
        await page.getByRole("link", { name, exact: true }).click();
    await page
        .getByRole("option", { name: /^Project notes / })
        .first()
        .waitFor();
    console.log("Loading boundaries:", await page.evaluate(() => window.notesNavigation.loading));
    // Fallbacks are performance evidence, not a reason to preload all editor
    // fragments globally or retain the previous note after its route changes.
    assert.deepEqual(
        await page.evaluate(() => window.notesNavigation.mismatches),
        [],
        "previous note remained visible after selection changed"
    );
    assert.deepEqual(errors, []);
    console.log("PASS: stable shell and no stale note during navigation; readiness timings recorded");
} finally {
    await browser.close();
}
