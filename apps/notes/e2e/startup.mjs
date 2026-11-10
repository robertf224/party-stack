import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const base = process.argv[2];
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const id = crypto.randomUUID();
const browser = await chromium.launch();
try {
    await sdk.actions.createNote({
        id,
        title: "Startup fixture",
        notebookId: "device:personal",
        kind: "note",
    });
    for (const path of ["/", `/folders/device%3Apersonal/${id}`]) {
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            colorScheme: "dark",
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("requestfailed", (request) =>
            errors.push(`${request.url()}: ${request.failure()?.errorText}`)
        );
        await page.addInitScript(() => {
            window.startupAudit = { skeletonFrames: 0, overlappingSplashes: 0, frames: 0 };
            const visible = (element) =>
                element.getClientRects().length && getComputedStyle(element).visibility === "visible";
            const sample = () => {
                window.startupAudit.frames++;
                if ([...document.querySelectorAll(".list-skeleton,.preview-skeleton")].some(visible))
                    window.startupAudit.skeletonFrames++;
                if ([...document.querySelectorAll(".opening")].filter(visible).length > 1)
                    window.startupAudit.overlappingSplashes++;
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        console.log("Checking cold startup:", path);
        await page.goto(new URL(path, base).href);
        try {
            await page.waitForFunction(
                () => document.querySelector(".boot-workspace")?.style.visibility === "visible"
            );
        } catch (error) {
            console.log("Startup errors:", errors);
            console.log("Visible startup state:", await page.locator("body").innerText());
            await page.screenshot({ path: "/tmp/party-notes-startup-failure.png" });
            throw error;
        }
        if (path === "/") await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
        else await page.getByRole("textbox", { name: "Note content", exact: true }).waitFor();
        const audit = await page.evaluate(() => window.startupAudit);
        assert.equal(audit.skeletonFrames, 0, `mobile startup exposed skeletons: ${path}`);
        assert.equal(audit.overlappingSplashes, 0);
        console.log(path, audit);
        await context.close();
    }
    console.log("PASS: cold mobile folder and note startup use one splash without list skeletons");
} finally {
    await browser.close();
    await sdk.actions.updateNote({ note: id, trashed: true });
    await sdk.cleanup();
}
