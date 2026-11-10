import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";
import { installStorageCounters, readTabTraces } from "./storage-counters.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const sdk = await createLiveOntology({ client: httpClient("http://127.0.0.1:5173/api/ontology/rpc") });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
const page = await context.newPage();
page.on("pageerror", (error) => console.error("Page error:", error.message));
const folders = [];
const visits = [];
const fixturePath = process.env.PARTY_FOLDER_FIXTURE;
const keepFixture = process.env.PARTY_KEEP_FIXTURE === "1";
await page.addInitScript(() => {
    const wire = (window.folderWire = { requests: [], replies: [], workerUrl: "" });
    const record = (data, direction) => {
        if (Array.isArray(data)) {
            for (const item of data) record(item, direction);
            return;
        }
        if (!data || typeof data !== "object") return;
        if (data._tag === "Request")
            wire.requests.push({
                at: performance.timeOrigin + performance.now(),
                id: String(data.id),
                tag: data.tag,
            });
        else if (data._tag)
            wire.replies.push({
                at: performance.timeOrigin + performance.now(),
                id: String(data.requestId ?? data.id ?? ""),
                tag: data._tag,
            });
    };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
        record(args[0], "send");
        return post.apply(this, args);
    };
    const Worker = SharedWorker;
    globalThis.SharedWorker = new Proxy(Worker, {
        construct(target, args) {
            wire.workerUrl = String(args[0]);
            const worker = Reflect.construct(target, args);
            worker.port.addEventListener("message", (event) => record(event.data, "receive"));
            return worker;
        },
    });
});
try {
    let reusedFixture = false;
    if (fixturePath) {
        try {
            const saved = JSON.parse(await readFile(fixturePath, "utf8"));
            assert.equal(saved.length, 2, "The shared fixture must contain two folders.");
            for (const folder of saved) {
                assert.equal(typeof folder.id, "string");
                assert.equal(typeof folder.name, "string");
                assert.ok(Array.isArray(folder.notes) && folder.notes.length === 4);
                assert.ok(folder.notes.every((id) => typeof id === "string"));
            }
            folders.push(...saved);
            reusedFixture = true;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    if (!reusedFixture) {
        for (const name of ["Folder timing A", "Folder timing B"]) {
            const id = crypto.randomUUID();
            await sdk.actions.createNotebook({ id, name, color: "#829bbc" });
            const notes = [];
            folders.push({ id, name, notes });
            for (let i = 0; i < 4; i++) {
                const note = crypto.randomUUID();
                await sdk.actions.createNote({
                    id: note,
                    notebookId: id,
                    kind: "note",
                    title: `${name} ${i}`,
                });
                notes.push(note);
            }
        }
        if (fixturePath) await writeFile(fixturePath, JSON.stringify(folders, null, 2));
    }
    console.log(
        reusedFixture ? "Reusing fixture folders" : "Seeded fixture folders",
        folders.map((folder) => folder.id)
    );
    await page.goto(new URL(`/folders/${folders[0].id}`, base).href);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await setFolderDownload(page, true);
    await page.evaluate(async (folders) => {
        const { noteSources } = await import("/e2e/inspect-tab.ts");
        const sources = noteSources();
        const records = [];
        const check = () => {
            const current = records.at(-1);
            if (!current || current.ready !== undefined) return;
            if (
                (current.name === "Recently deleted" &&
                    location.pathname === "/trash" &&
                    document.querySelectorAll('.folder-query-view:not([aria-hidden="true"]) .note-preview')
                        .length > 10) ||
                [...document.querySelectorAll(".note-preview")].some((row) =>
                    row.textContent.includes(current.name)
                )
            )
                current.ready = performance.now() - current.start;
        };
        for (const source of sources) {
            const load = source._sync.loadSubset.bind(source._sync);
            source._sync.loadSubset = (subset) => {
                const current = records.at(-1);
                const start = performance.now();
                const result = load(subset);
                if (current) {
                    const request = {
                        at: start - current.start,
                        where: subset.where,
                        orderBy: subset.orderBy,
                        cursor: subset.cursor,
                        limit: subset.limit,
                        sync: result === true,
                    };
                    current.loads.push(request);
                    if (result !== true)
                        void result.then(() => {
                            request.ready = performance.now() - current.start;
                        });
                }
                return result;
            };
        }
        document.addEventListener(
            "click",
            (event) => {
                const path = event.target.closest("a")?.getAttribute("href");
                const folder =
                    folders.find((folder) => path === `/folders/${folder.id}`) ??
                    (path === "/trash" ? { name: "Recently deleted", notes: [] } : undefined);
                if (!folder) return;
                records.push({
                    name: folder.name,
                    start: performance.now(),
                    epoch: performance.timeOrigin + performance.now(),
                    loadedInTab: [...sources].some((source) => folder.notes.every((id) => source.has(id))),
                    loads: [],
                });
                queueMicrotask(check);
            },
            true
        );
        new MutationObserver(check).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
        });
        window.folderTiming = records;
    }, folders);
    for (const index of [1, 0, 1, 0]) {
        console.log("Opening", folders[index].name);
        await page.getByRole("link", { name: folders[index].name, exact: true }).click();
        await page.waitForFunction(() => window.folderTiming.at(-1)?.ready !== undefined);
        if (index === 1 && (await page.evaluate(() => window.folderTiming.length === 1))) {
            const worker = await page.evaluate(async () => {
                const { inspectWorker } = await import("/e2e/inspect-worker.ts");
                return inspectWorker(window.folderWire.workerUrl);
            });
            await writeFile("/tmp/party-folder-worker-traces.json", JSON.stringify(worker, null, 2));
            await writeFile(
                "/tmp/party-folder-wire.json",
                JSON.stringify(await page.evaluate(() => window.folderWire), null, 2)
            );
        }
    }
    console.log(JSON.stringify(await page.evaluate(() => window.folderTiming), null, 2));
    const workerProtocol = await browser.newBrowserCDPSession();
    const { targetInfos } = await workerProtocol.send("Target.getTargets");
    const workerTarget = targetInfos.find((target) => target.type === "shared_worker");
    let workerProfile;
    if (workerTarget) {
        const { sessionId } = await workerProtocol.send("Target.attachToTarget", {
            targetId: workerTarget.targetId,
            flatten: false,
        });
        let nextId = 0;
        const pending = new Map();
        workerProtocol.on("Target.receivedMessageFromTarget", (event) => {
            if (event.sessionId !== sessionId) return;
            const reply = JSON.parse(event.message);
            const waiter = pending.get(reply.id);
            if (!waiter) return;
            pending.delete(reply.id);
            if (reply.error) waiter.reject(new Error(reply.error.message));
            else waiter.resolve(reply.result);
        });
        workerProfile = (method, params) =>
            new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                void workerProtocol
                    .send("Target.sendMessageToTarget", {
                        sessionId,
                        message: JSON.stringify({ id, method, params }),
                    })
                    .catch(reject);
            });
        await workerProfile("Profiler.enable");
    }
    let trashVisits = 0;
    for (const path of ["/trash", `/folders/${folders[0].id}`, "/trash", `/folders/${folders[1].id}`]) {
        const profile = await context.newCDPSession(page);
        if (path === "/trash") {
            await profile.send("Profiler.enable");
            await profile.send("Profiler.start");
            await workerProfile?.("Profiler.start");
            await workerProfile?.("Runtime.evaluate", {
                expression: `(${installStorageCounters.toString()})()`,
            });
        }
        const started = performance.now();
        const startedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
        await page.locator(`.sidebar a[href="${path}"]`).click();
        if (path === "/trash") await page.locator(".note-preview").nth(10).waitFor();
        else
            await page
                .locator(".note-preview")
                .filter({ hasText: folders.find((folder) => path.endsWith(folder.id)).name })
                .first()
                .waitFor();
        const readyAt = await page.evaluate(() => performance.timeOrigin + performance.now());
        visits.push({ path, startedAt, readyAt, durationMs: performance.now() - started });
        await writeFile("/tmp/party-folder-visits.json", JSON.stringify(visits, null, 2));
        console.log(
            "Trash round trip",
            path,
            Math.round(performance.now() - started),
            "ms",
            await page.locator(".note-preview").count()
        );
        if (path === "/trash") {
            const counts = await workerProfile?.("Runtime.evaluate", {
                expression: "globalThis.__partyStorageCounters?.stop()",
                returnByValue: true,
            });
            await writeFile(
                `/tmp/party-trash-native-${trashVisits}.json`,
                JSON.stringify(counts?.result?.value ?? [], null, 2)
            );
            await writeFile(
                `/tmp/party-trash-tab-traces-${trashVisits}.json`,
                JSON.stringify(await page.evaluate(readTabTraces), null, 2)
            );
            await writeFile(
                `/tmp/party-trash-records-${trashVisits}.json`,
                JSON.stringify(
                    await page.evaluate(() => ({
                        timeOrigin: performance.timeOrigin,
                        records: window.folderTiming,
                        wire: window.folderWire,
                    })),
                    null,
                    2
                )
            );
            const { profile: cpu } = await profile.send("Profiler.stop");
            await writeFile(`/tmp/party-trash-${trashVisits}.cpuprofile`, JSON.stringify(cpu));
            if (workerProfile) {
                const { profile: cpu } = await workerProfile("Profiler.stop");
                await writeFile(`/tmp/party-trash-worker-${trashVisits}.cpuprofile`, JSON.stringify(cpu));
            }
            const worker = await page.evaluate(async () => {
                const { inspectWorker } = await import("/e2e/inspect-worker.ts");
                return inspectWorker(window.folderWire.workerUrl);
            });
            await writeFile(`/tmp/party-trash-worker-traces-${trashVisits++}.json`, JSON.stringify(worker));
        }
        await profile.detach();
    }
    await workerProtocol.detach();
    await writeFile(
        "/tmp/party-folder-all-records.json",
        JSON.stringify(await page.evaluate(() => window.folderTiming), null, 2)
    );
    const firstFolder = page.getByRole("link", { name: folders[0].name, exact: true });
    await firstFolder.focus();
    const nextHref = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".sidebar a.nav-item")];
        return items[items.indexOf(document.activeElement) + 1]?.getAttribute("href");
    });
    await page.keyboard.press("ArrowDown");
    console.log(
        "ArrowDown folder state",
        await page.evaluate(() => ({
            url: location.pathname,
            focus: document.activeElement?.outerHTML,
            expected: document.querySelector(".sidebar a.nav-item:focus")?.getAttribute("href"),
        }))
    );
    await page.waitForURL((url) => url.pathname === nextHref);
    await page.keyboard.press("End");
    await page.waitForURL((url) => url.pathname === "/trash");
    assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Recently deleted"
    );
    const selection = await page.evaluate(() => {
        const row = document.activeElement;
        return {
            background: getComputedStyle(row).backgroundColor,
            icon: getComputedStyle(row.querySelector("svg")).color,
        };
    });
    assert.notEqual(selection.background, "rgba(0, 0, 0, 0)");
    await page.keyboard.press("Home");
    await page.waitForURL((url) => url.pathname === "/");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Notes");
    console.log(
        "PASS: folders and Recently Deleted use roving keyboard selection without moving focus into the editor"
    );
} catch (error) {
    console.log(
        "Folder failure state",
        await page.evaluate(() => ({
            path: location.pathname,
            notes: document.querySelectorAll(".note-preview").length,
            pending: document.querySelectorAll('[data-testid*="pending"], .note-list-skeleton').length,
            errors: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
        }))
    );
    const report = await page.evaluate(async () => {
        const { inspectWorker } = await import("/e2e/inspect-worker.ts");
        return inspectWorker(window.folderWire.workerUrl);
    });
    await writeFile("/tmp/party-folder-failure-worker.json", JSON.stringify(report, null, 2));
    throw error;
} finally {
    await browser.close();
    if (!keepFixture) {
        for (const folder of folders) await sdk.actions.deleteNotebook({ notebook: folder.id });
        if (fixturePath) await rm(fixturePath, { force: true });
    }
    await sdk.cleanup();
}
