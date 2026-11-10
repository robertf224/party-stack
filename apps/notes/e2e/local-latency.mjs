import { writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
const base = process.argv[2];
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const folder = crypto.randomUUID();
const browser = await chromium.launch(
    process.env.PARTY_BROWSER_CHANNEL ? { channel: process.env.PARTY_BROWSER_CHANNEL } : {}
);
console.log("Browser:", browser.version(), process.env.PARTY_BROWSER_CHANNEL ?? "bundled-chromium");
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("Page error:", e.message));
let made = false;
try {
    await sdk.actions.createNotebook({ id: folder, name: "Latency fixture", color: "#829bbc" });
    made = true;
    await page.goto(new URL(`/folders/${folder}`, base).href);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page.evaluate(async (folder) => {
        const { recordNewNotes } = await import("/e2e/local-latency.ts");
        window.notesTiming = recordNewNotes(folder);
    }, folder);
    const cdp = await context.newCDPSession(page);
    if (process.argv[3] === "profile") {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.start");
    }
    for (let i = 0; i < 5; i++) {
        await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).click();
        await page.getByRole("menuitem", { name: "Note", exact: true }).click();
        await page.waitForFunction(() => window.notesTiming.records.at(-1)?.paint !== undefined);
    }
    console.log(JSON.stringify(await page.evaluate(() => window.notesTiming.records), null, 2));
    await page.evaluate(() => window.notesTiming.stop());
    if (process.argv[3] === "profile") {
        const { profile } = await cdp.send("Profiler.stop");
        await writeFile("/tmp/party-notes-new-note.cpuprofile", JSON.stringify(profile));
    }
    await cdp.detach();
    await page.evaluate(async () => {
        const { recordKeyboardNavigation } = await import("/e2e/local-latency.ts");
        window.navigationTiming = recordKeyboardNavigation();
    });
    const currentId = await page.locator(".note-page").getAttribute("data-note-id");
    await page.keyboard.press("Meta+Enter");
    const focusedId = await page.evaluate(() =>
        document.activeElement?.closest(".note-preview")?.getAttribute("data-note-id")
    );
    if (focusedId !== currentId) {
        console.log(
            "Cmd+Enter state:",
            await page.evaluate(() => ({
                path: location.pathname,
                focus: document.activeElement?.outerHTML,
                rows: [...document.querySelectorAll(".note-preview")].map((row) => row.dataset.noteId),
            }))
        );
        throw new Error("Cmd+Enter must focus the current note in the list");
    }
    await page.locator(".note-preview").first().focus();
    for (const key of [
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "ArrowDown",
        "ArrowUp",
        "ArrowUp",
        "ArrowUp",
        "ArrowUp",
    ]) {
        await page.keyboard.press(key);
        await page.waitForFunction(() => window.navigationTiming.records.at(-1)?.ready !== undefined);
    }
    const navigation = await page.evaluate(() => {
        window.navigationTiming.stop();
        return window.navigationTiming.records;
    });
    console.log("Cached keyboard navigation:", JSON.stringify(navigation, null, 2));
    if (navigation.some((record) => !record.keptListFocus))
        throw new Error("Keyboard navigation stole focus from the note list");
} finally {
    await browser.close();
    if (made) await sdk.actions.deleteNotebook({ notebook: folder });
    await sdk.cleanup();
}
