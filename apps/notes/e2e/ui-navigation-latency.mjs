// Read-only UI timing, usable against both Vite dev and the production preview.
// The disposable browser's offline pin is populated through the normal UI.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";
import { readTabTraces } from "./storage-counters.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const coldWorker = process.env.PARTY_COLD_WORKER === "1";
if (coldWorker && process.env.PARTY_BOOT_PROBE !== "1")
    throw new Error("PARTY_COLD_WORKER=1 requires PARTY_BOOT_PROBE=1.");
const profile = coldWorker ? await mkdtemp(join(tmpdir(), "party-notes-cold-worker-")) : undefined;
const launchOptions = { channel: process.env.PARTY_BROWSER_CHANNEL ?? "chrome" };
const contextOptions = {
    viewport: { width: 1440, height: 960 },
    colorScheme: "dark",
    // Only for the ephemeral localhost HTTP/2 benchmark proxy.
    ignoreHTTPSErrors: process.env.PARTY_INSECURE_LOCAL_TLS === "1",
};
async function launch() {
    if (profile) {
        const context = await chromium.launchPersistentContext(profile, {
            ...launchOptions,
            ...contextOptions,
        });
        const browser = context.browser();
        assert.ok(browser, "The persistent context must expose its browser.");
        return { browser, context };
    }
    const browser = await chromium.launch(launchOptions);
    return { browser, context: await browser.newContext(contextOptions) };
}
let { browser, context } = await launch();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
    await page.goto(new URL("/", base).href);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await setFolderDownload(page, true);
    await page.evaluate(() => {
        const rows = () => [
            ...document.querySelectorAll('.folder-query-view:not([aria-hidden="true"]) .note-preview'),
        ];
        const homeIds = rows().map((row) => row.dataset.noteId);
        const records = (window.uiNavigationTiming = []);
        document.addEventListener(
            "click",
            (event) => {
                const path = event.target.closest(".sidebar a")?.getAttribute("href");
                if (path !== "/" && path !== "/trash") return;
                const record = { path, startedAt: performance.now() };
                records.push(record);
                const check = () => {
                    const ids = rows().map((row) => row.dataset.noteId);
                    const expected =
                        path === "/"
                            ? ids.length === homeIds.length && ids.every((id, n) => id === homeIds[n])
                            : ids.length > 10;
                    if (
                        location.pathname === path &&
                        expected &&
                        document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true"
                    ) {
                        record.rows = ids.length;
                        record.readyMs = performance.now() - record.startedAt;
                        requestAnimationFrame(() => {
                            record.paintMs = performance.now() - record.startedAt;
                        });
                    } else requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
            },
            true
        );
    });
    for (const [index, path] of ["/trash", "/", "/trash"].entries()) {
        await page.locator(`.sidebar a[href="${path}"]`).click();
        await page.waitForFunction((n) => window.uiNavigationTiming[n]?.paintMs !== undefined, index);
    }
    assert.deepEqual(errors, []);
    const result = {
        url: base,
        browser: browser.version(),
        records: await page.evaluate(() => window.uiNavigationTiming),
    };
    if (process.env.PARTY_BOOT_PROBE === "1") {
        if (coldWorker) {
            // Closing the entire persistent context also closes its browser and
            // worker. Reopening the same temporary profile preserves native
            // IndexedDB, encryption keys and attachment caches without seeding.
            await context.close();
            ({ browser, context } = await launch());
            const protocol = await browser.newBrowserCDPSession();
            try {
                const { targetInfos } = await protocol.send("Target.getTargets");
                const workers = targetInfos.filter((target) => target.type === "shared_worker");
                assert.equal(workers.length, 0, "No SharedWorker may survive the browser restart.");
                result.bootWorkerState = "restarted-with-populated-durable-cache";
                result.sharedWorkersBeforeBoot = workers.length;
            } finally {
                await protocol.detach();
            }
        } else result.bootWorkerState = "retained-with-populated-durable-cache";
        // In either mode the measured page acquires a fresh memory replica.
        const fresh = await context.newPage();
        result.bootProfiled = process.env.PARTY_BOOT_CPU === "1";
        // Optional CPU attribution only. Keep clean latency runs unprofiled.
        const profiler = process.env.PARTY_BOOT_CPU === "1" ? await context.newCDPSession(fresh) : undefined;
        if (profiler) {
            await profiler.send("Performance.enable");
            await profiler.send("Profiler.enable");
            await profiler.send("Profiler.setSamplingInterval", { interval: 100 });
            await profiler.send("Profiler.start");
        }
        fresh.on("pageerror", (error) => errors.push(error.message));
        await fresh.addInitScript(() => {
            const timing = (window.uiBootTiming = {
                timeOrigin: performance.timeOrigin,
                wire: [],
                timers: [],
                dom: [],
                longTasks: [],
            });
            // Observe React's retry timers without changing their delay, callback
            // arguments, return handles, exceptions or cancellation behavior.
            const timers = new Map();
            const nativeTimeout = window.setTimeout;
            const nativeClearTimeout = window.clearTimeout;
            window.setTimeout = function (callback, delay, ...args) {
                if (
                    typeof callback !== "function" ||
                    typeof delay !== "number" ||
                    delay < 10 ||
                    delay > 350 ||
                    timing.timers.length >= 100
                )
                    return nativeTimeout.call(this, callback, delay, ...args);
                const record = {
                    scheduledAt: performance.now(),
                    delay,
                    callback: callback.name,
                    stack: new Error().stack?.split("\n").slice(1, 9),
                };
                const handle = nativeTimeout.call(
                    this,
                    function (...parameters) {
                        record.firedAt = performance.now();
                        timers.delete(handle);
                        return callback.apply(this, parameters);
                    },
                    delay,
                    ...args
                );
                timers.set(handle, record);
                timing.timers.push(record);
                return handle;
            };
            window.clearTimeout = function (handle) {
                const record = timers.get(handle);
                if (record) {
                    record.cancelledAt = performance.now();
                    timers.delete(handle);
                }
                return nativeClearTimeout.call(this, handle);
            };
            let previousDOM;
            const observeDOM = () => {
                const shell = document.querySelector(".note-list");
                const listbox = document.querySelector(
                    '.folder-query-view:not([aria-hidden="true"]) [role="listbox"]'
                );
                const rows = document.querySelectorAll(
                    '.folder-query-view:not([aria-hidden="true"]) .note-preview'
                );
                const workspace = document.querySelector(".boot-workspace");
                const snapshot = {
                    splash: !!document.querySelector('.opening[role="status"]'),
                    workspace: !!workspace,
                    workspaceVisibility: workspace?.style.visibility,
                    listShell: !!shell,
                    listbox: !!listbox,
                    rows: rows.length,
                };
                const signature = JSON.stringify(snapshot);
                if (signature !== previousDOM && timing.dom.length < 100) {
                    previousDOM = signature;
                    timing.dom.push({ at: performance.now(), ...snapshot });
                }
                if (shell && !listbox) timing.emptyListShellCommittedAt ??= performance.now();
                if (listbox) timing.listboxCommittedAt ??= performance.now();
                if (rows.length > 10) timing.rowsDOMCommittedAt ??= performance.now();
            };
            const mutations = new MutationObserver(observeDOM);
            mutations.observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["style", "class", "aria-hidden", "aria-busy"],
            });
            observeDOM();
            const tasks = new PerformanceObserver((list) => {
                for (const entry of list.getEntries())
                    if (timing.longTasks.length < 100)
                        timing.longTasks.push({ at: entry.startTime, duration: entry.duration });
            });
            tasks.observe({ type: "longtask", buffered: true });
            const record = (data, direction) => {
                if (Array.isArray(data)) return data.forEach((item) => record(item, direction));
                if (!data?._tag) return;
                timing.wire.push({
                    at: performance.now(),
                    direction,
                    id: String(data.requestId ?? data.id ?? ""),
                    tag: data._tag === "Request" ? data.tag : data._tag,
                });
            };
            const postMessage = MessagePort.prototype.postMessage;
            MessagePort.prototype.postMessage = function (...args) {
                record(args[0], "send");
                return postMessage.apply(this, args);
            };
            addEventListener("DOMContentLoaded", () => {
                timing.domContentLoadedAt = performance.now();
            });
            const NativeSharedWorker = globalThis.SharedWorker;
            globalThis.SharedWorker = new Proxy(NativeSharedWorker, {
                construct(target, args) {
                    timing.workerAcquisitionAt ??= performance.now();
                    const worker = Reflect.construct(target, args);
                    worker.port.addEventListener("message", (event) => record(event.data, "receive"));
                    return worker;
                },
            });
            const check = () => {
                const rows = document.querySelectorAll(
                    '.folder-query-view:not([aria-hidden="true"]) .note-preview'
                );
                if (
                    rows.length > 10 &&
                    document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true"
                ) {
                    timing.rowsMountedAt ??= performance.now();
                    if (getComputedStyle(rows[0]).visibility === "visible") {
                        timing.rowsVisibleAt = performance.now();
                        timing.rowCount = rows.length;
                        requestAnimationFrame(() => {
                            timing.paintAt = performance.now();
                            mutations.disconnect();
                            tasks.disconnect();
                        });
                        return;
                    }
                }
                requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
        });
        await fresh.goto(new URL("/trash", base).href);
        await fresh.waitForFunction(() => window.uiBootTiming?.paintAt !== undefined);
        result.boot = await fresh.evaluate(() => window.uiBootTiming);
        if (profiler) {
            const { profile } = await profiler.send("Profiler.stop");
            const { metrics } = await profiler.send("Performance.getMetrics");
            const navigationStart = metrics.find((metric) => metric.name === "NavigationStart")?.value;
            await writeFile("/tmp/party-ui-boot.cpuprofile", JSON.stringify(profile));
            await writeFile(
                "/tmp/party-ui-boot-profile-clock.json",
                JSON.stringify({ timeOrigin: result.boot.timeOrigin, navigationStart }, null, 2)
            );
            await profiler.detach();
        }
        const traces = await fresh.evaluate(readTabTraces).catch((error) => ({ error: error.message }));
        await writeFile("/tmp/party-ui-boot-traces.json", JSON.stringify(traces, null, 2));
        await fresh.close();
        assert.deepEqual(errors, []);
    }
    await writeFile("/tmp/party-ui-navigation.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally {
    await browser.close();
    if (profile) await rm(profile, { recursive: true, force: true });
}
