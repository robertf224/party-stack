import assert from "node:assert/strict";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const id = crypto.randomUUID();
const title = `Sidebar query fixture ${id.slice(0, 6)}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
await page.addInitScript((id) => {
    window.folderAudit = { skeletonFrames: 0, missingFolderFrames: 0, rpc: [] };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
        const record = (message) => {
            if (Array.isArray(message)) return message.forEach(record);
            if (message?._tag === "Request") window.folderAudit.rpc.push(message.tag);
        };
        record(args[0]);
        return post.apply(this, args);
    };
    const sample = () => {
        const sidebar = document.querySelector(".notes-app > aside.sidebar");
        if (
            document.querySelector(".boot-workspace")?.style.visibility === "visible" &&
            sidebar?.querySelector('[aria-label="Hide folders"]') &&
            !sidebar.querySelector(`a[href="/folders/${id}"]`)
        )
            window.folderAudit.missingFolderFrames++;
        if (
            [...document.querySelectorAll(".folder-skeleton")].some(
                (el) => el.getClientRects().length && getComputedStyle(el).visibility === "visible"
            )
        )
            window.folderAudit.skeletonFrames++;
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
}, id);
try {
    await sdk.actions.createNotebook({ id, name: title, color: "#829bbc" });
    await page.goto(process.argv[2]);
    await page.waitForFunction(
        () => document.querySelector(".boot-workspace")?.style.visibility === "visible"
    );
    await page.locator(".folder-skeleton").waitFor({ state: "hidden" });
    await page.evaluate(() => {
        window.folderAudit.rpc = [];
    });
    for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: "Hide folders", exact: true }).click();
        await page.getByRole("button", { name: "Show folders", exact: true }).click();
        await page.locator(".folder-skeleton").waitFor({ state: "hidden" });
    }
    const audit = await page.evaluate(() => window.folderAudit);
    console.log("Sidebar query lifecycle:", audit);
    if (!process.argv.includes("--baseline")) {
        assert.equal(audit.skeletonFrames, 0, "opening folders must reuse the workspace live query");
        assert.equal(
            audit.missingFolderFrames,
            0,
            "folders must already be available whenever the workspace/sidebar appears"
        );
    }
} finally {
    await browser.close();
    await sdk.actions.deleteNotebook({ notebook: id });
    await sdk.cleanup();
}
