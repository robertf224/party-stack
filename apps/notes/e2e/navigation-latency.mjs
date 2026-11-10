import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";
import { installSqliteHost } from "./sqlite-context.mjs";
import { installStorageCounters, readTabTraces } from "./storage-counters.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const fullTrashImport = process.env.PARTY_FULL_TRASH_IMPORT === "1";
const idleAfterSetupMs = Number(process.env.PARTY_IDLE_AFTER_SETUP_MS ?? 0);
if (!Number.isFinite(idleAfterSetupMs) || idleAfterSetupMs < 0)
    throw new Error("PARTY_IDLE_AFTER_SETUP_MS must be a non-negative number.");
if (fullTrashImport && process.env.PARTY_DOWNLOAD_OFFLINE !== "1")
    throw new Error("Full Trash import requires PARTY_DOWNLOAD_OFFLINE=1 to establish worker coverage.");
const browser = await chromium.launch(
    process.env.PARTY_BROWSER_CHANNEL ? { channel: process.env.PARTY_BROWSER_CHANNEL } : {}
);
const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "dark",
    ignoreHTTPSErrors: process.env.PARTY_IGNORE_HTTPS_ERRORS === "1",
});
let page = await context.newPage();
const installWireRecorder = () => {
    const wire = (window.navigationWire = { workerUrl: "", requests: [] });
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
        const collect = (value) => {
            if (Array.isArray(value)) return value.forEach(collect);
            if (value?._tag === "Request")
                wire.requests.push({
                    at: performance.timeOrigin + performance.now(),
                    id: String(value.id),
                    tag: value.tag,
                });
        };
        collect(args[0]);
        return original.apply(this, args);
    };
    globalThis.SharedWorker = new Proxy(SharedWorker, {
        construct(target, args) {
            wire.workerUrl = String(args[0]);
            return Reflect.construct(target, args);
        },
    });
};
page.on("pageerror", (error) => console.error("Page error:", error.message));
await page.addInitScript(installWireRecorder);
let worker;
let workerCall;
let sqliteHost;
try {
    if (process.env.PARTY_SQLITE_HOST === "1") sqliteHost = await installSqliteHost(context, base);
    await page.goto(new URL("/", base).href);
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    if (process.env.PARTY_RELOAD_CACHED_TRASH === "1") {
        // Match an existing device cache with a fresh memory tab. This only
        // reads the ordinary UI; it does not seed rows or fabricate coverage.
        await page.locator('.sidebar a[href="/trash"]').click();
        await page.waitForFunction(
            () =>
                document.querySelectorAll('.folder-query-view:not([aria-hidden="true"]) .note-preview')
                    .length > 10 &&
                document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true",
            undefined,
            { timeout: 30_000 }
        );
        await page.locator('.sidebar a[href="/"]').click();
        await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
        await page.reload();
        await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    }
    if (process.env.PARTY_DOWNLOAD_OFFLINE === "1") {
        await setFolderDownload(page, true);
    }
    // Compare retained caches after released demand has expired, without clearing
    // storage or including the idle period in navigation latency measurements.
    if (idleAfterSetupMs > 0) await page.waitForTimeout(idleAfterSetupMs);
    if (fullTrashImport) {
        // Keep the populated worker alive while opening a genuinely fresh tab replica.
        // Close the setup tab before timing; no Trash query has run in the new tab.
        const setupPage = page;
        page = await context.newPage();
        page.on("pageerror", (error) => console.error("Page error:", error.message));
        await page.addInitScript(installWireRecorder);
        await page.goto(new URL("/", base).href);
        await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
        await setupPage.close();
    }
    const protocol = await browser.newBrowserCDPSession();
    const { targetInfos } = await protocol.send("Target.getTargets");
    const target = targetInfos.find((item) => item.type === "shared_worker");
    if (!target) throw new Error("Notes SharedWorker was not found.");
    const { sessionId } = await protocol.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
    });
    let nextId = 0;
    const pending = new Map();
    protocol.on("Target.receivedMessageFromTarget", (event) => {
        if (event.sessionId !== sessionId) return;
        const result = JSON.parse(event.message);
        const request = pending.get(result.id);
        if (!request) return;
        pending.delete(result.id);
        result.error ? request.reject(new Error(result.error.message)) : request.resolve(result.result);
    });
    workerCall = (method, params) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            void protocol
                .send("Target.sendMessageToTarget", {
                    sessionId,
                    message: JSON.stringify({
                        id,
                        method,
                        params,
                    }),
                })
                .catch(reject);
        });
    worker = (expression) => workerCall("Runtime.evaluate", { expression, returnByValue: true });
    if (process.env.PARTY_STORAGE_COUNTERS === "1") await worker(`(${installStorageCounters.toString()})()`);
    await page.evaluate(async () => {
        const { noteSources } = await import("/e2e/inspect-tab.ts");
        window.navigationInitialSources = [...noteSources()].map((source) => ({
            rows: source.size,
            trashRows: [...source.values()].filter((row) => row.trashed === true).length,
        }));
        const records = (window.navigationTiming = []);
        const rows = () => [
            ...document.querySelectorAll('.folder-query-view:not([aria-hidden="true"]) .note-preview'),
        ];
        const homeIds = rows().map((row) => row.dataset.noteId);
        let active;
        const start = (kind, target) => {
            active = {
                kind,
                target,
                start: performance.now(),
                epoch: performance.timeOrigin + performance.now(),
                loads: [],
            };
            records.push(active);
        };
        window.navigationStart = start;
        const check = () => {
            if (active && active.readyMs === undefined) {
                const elapsed = performance.now() - active.start;
                if (active.kind === "folder") {
                    const link = [...document.querySelectorAll(".sidebar a")].find(
                        (item) => item.getAttribute("href") === active.target
                    );
                    if (link?.getAttribute("aria-current") === "page") active.highlightMs ??= elapsed;
                    const ids = rows().map((row) => row.dataset.noteId);
                    const complete =
                        active.target === "/"
                            ? ids.length === homeIds.length && ids.every((id, index) => id === homeIds[index])
                            : ids.length > 10;
                    if (
                        location.pathname === active.target &&
                        complete &&
                        document.querySelector(
                            '.folder-query-view:not([aria-hidden="true"]) [role="listbox"]'
                        ) &&
                        document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true"
                    ) {
                        active.rows = ids;
                        active.readyMs = elapsed;
                    }
                } else {
                    const row = rows().find((item) => item.dataset.noteId === active.target);
                    if (row?.getAttribute("aria-selected") === "true") active.highlightMs ??= elapsed;
                    const documentReady = [...document.querySelectorAll(".note-page")].some(
                        (item) =>
                            item.dataset.noteId === active.target && item.querySelector(".note-document")
                    );
                    if (documentReady && active.highlightMs !== undefined) {
                        active.documentMs = elapsed;
                        active.readyMs = elapsed;
                        active.keptListFocus = !!document.activeElement?.closest(".note-preview");
                    }
                }
                if (active.readyMs !== undefined) {
                    const completed = active;
                    requestAnimationFrame(() => {
                        completed.paintMs = performance.now() - completed.start;
                    });
                }
            }
            requestAnimationFrame(check);
        };
        for (const source of noteSources()) {
            const load = source._sync.loadSubset.bind(source._sync);
            source._sync.loadSubset = (subset) => {
                const current = active;
                const result = load(subset);
                if (current) {
                    const request = {
                        at: performance.now() - current.start,
                        where: subset.where,
                        orderBy: subset.orderBy,
                        cursor: subset.cursor,
                        limit: subset.limit,
                        sync: result === true,
                    };
                    current.loads.push(request);
                    if (result !== true)
                        void result.then(
                            () => {
                                request.readyMs = performance.now() - current.start;
                            },
                            (error) => {
                                request.error = String(error?.message ?? error);
                            }
                        );
                }
                return result;
            };
        }
        document.addEventListener(
            "click",
            (event) => {
                const row = event.target.closest(".note-preview");
                if (row) {
                    if (!event.isTrusted && active?.kind === "key" && active.target === row.dataset.noteId)
                        return;
                    start("click", row.dataset.noteId);
                } else {
                    const path = event.target.closest(".sidebar a")?.getAttribute("href");
                    if (path === "/" || path === "/trash") start("folder", path);
                }
            },
            true
        );
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                const row = event.target.closest(".note-preview");
                if (!row) return;
                const items = rows();
                const index = items.indexOf(row);
                const next =
                    items[
                        Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
                    ];
                start("key", next.dataset.noteId);
                active.key = event.key;
            },
            true
        );
        requestAnimationFrame(check);
        window.navigationHomeIds = homeIds;
    });
    // Deliberately back-to-back: no diagnostic RPC or CPU upload drains work between interactions.
    let step = 0;
    const ready = () =>
        page.waitForFunction(
            (count) =>
                window.navigationTiming.length === count &&
                window.navigationTiming[count - 1]?.paintMs !== undefined,
            ++step,
            { timeout: 30_000 }
        );
    const tabProfiler =
        process.env.PARTY_PROFILE_FIRST_TRASH ||
        process.env.PARTY_PROFILE_WARM_CLICK ||
        process.env.PARTY_PROFILE_FIRST_CLICK
            ? await context.newCDPSession(page)
            : undefined;
    if (fullTrashImport || process.env.PARTY_COLLECT_TRACES === "1")
        await page.evaluate(readTabTraces, "start");
    if (tabProfiler) {
        await tabProfiler.send("Performance.enable");
        const { metrics } = await tabProfiler.send("Performance.getMetrics");
        const navigationStart = metrics.find((metric) => metric.name === "NavigationStart")?.value;
        if (navigationStart === undefined) throw new Error("Chrome did not report its navigation clock.");
        const timeOrigin = await page.evaluate(() => {
            performance.clearResourceTimings();
            performance.setResourceTimingBufferSize(2000);
            return performance.timeOrigin;
        });
        await writeFile(
            "/tmp/party-navigation-profile-clock.json",
            JSON.stringify({
                epochOffsetMs: timeOrigin - navigationStart * 1000,
                timeOrigin,
                navigationStartSeconds: navigationStart,
            })
        );
        await tabProfiler.send("Profiler.enable");
        if (process.env.PARTY_PROFILE_FIRST_TRASH) {
            await workerCall("Profiler.enable", {});
            await tabProfiler.send("Profiler.start");
            await workerCall("Profiler.start", {});
        }
    }
    const stopFirstTrashProfile = async () => {
        const { profile } = await tabProfiler.send("Profiler.stop");
        await writeFile("/tmp/party-navigation-first-trash.cpuprofile", JSON.stringify(profile));
        const workerProfile = await workerCall("Profiler.stop", {});
        await writeFile(
            "/tmp/party-navigation-first-trash-worker.cpuprofile",
            JSON.stringify(workerProfile.profile)
        );
    };
    if (fullTrashImport) {
        await page.evaluate(async () => {
            const { noteSources } = await import("/e2e/inspect-tab.ts");
            // Resolve the exact DB module already used by these native collections.
            const inspector = await (await fetch("/e2e/inspect-tab.ts")).text();
            const dbUrl = inspector.match(/from\s*["']([^"']*\/@tanstack_db\.js[^"']*)["']/)?.[1];
            if (!dbUrl) throw new Error("The active TanStack DB module URL was not found.");
            const { eq, createLiveQueryCollection } = await import(dbUrl);
            const sources = [...noteSources()];
            if (sources.length !== 1)
                throw new Error(`Expected one native Note source, got ${sources.length}.`);
            const [source] = sources;
            window.navigationStart("full-trash-import", "Note.trashed");
            const record = window.navigationTiming.at(-1);
            record.initialSourceRows = source.size;
            record.initialTrashRows = [...source.values()].filter((row) => row.trashed === true).length;
            let result;
            try {
                if (record.initialTrashRows !== 0)
                    throw new Error(
                        `Fresh-tab workload already contains ${record.initialTrashRows} Trash rows.`
                    );
                result = createLiveQueryCollection({
                    query: (query) =>
                        query.from({ note: source }).where(({ note }) => eq(note.trashed, true)),
                });
                await result.preload();
                const rows = result.toArray;
                record.readyMs = performance.now() - record.start;
                record.count = rows.length;
                if (rows.some((row) => row.trashed !== true))
                    throw new Error("Full Trash import returned an untrashed note.");
                if (rows.length < 1000)
                    throw new Error(`Full Trash workload needs at least 1000 rows; got ${rows.length}.`);
                await new Promise((resolve) => requestAnimationFrame(resolve));
                record.paintMs = performance.now() - record.start;
                // Compare actual data after the measured first paint without recording note contents.
                const ordered = [...rows].sort((left, right) =>
                    String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0
                );
                const canonical = JSON.stringify(ordered, (_key, value) =>
                    value && typeof value === "object" && !Array.isArray(value)
                        ? Object.fromEntries(
                              Object.keys(value)
                                  .sort()
                                  .map((key) => [key, value[key]])
                          )
                        : value
                );
                record.dataHash = Array.from(
                    new Uint8Array(
                        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
                    ),
                    (byte) => byte.toString(16).padStart(2, "0")
                ).join("");
            } catch (error) {
                record.error = String(error?.message ?? error);
                throw error;
            } finally {
                // queryOnce also awaits cleanup, which releases all row ownership.
                // Measure available query data separately from that later teardown.
                const cleanupStarted = performance.now();
                await result?.cleanup();
                record.cleanupMs = performance.now() - cleanupStarted;
            }
        });
        if (tabProfiler && process.env.PARTY_PROFILE_FIRST_TRASH) await stopFirstTrashProfile();
    }
    for (const path of fullTrashImport
        ? []
        : process.env.PARTY_FIRST_TRASH_ONLY
          ? ["/trash"]
          : ["/trash", "/", "/trash"]) {
        await page.locator(`.sidebar a[href="${path}"]`).click();
        await ready();
        if (tabProfiler && process.env.PARTY_PROFILE_FIRST_TRASH && step === 1) {
            await stopFirstTrashProfile();
        }
    }
    for (let index = 1; !fullTrashImport && !process.env.PARTY_FIRST_TRASH_ONLY && index <= 8; index++) {
        const profileClick = process.env.PARTY_PROFILE_FIRST_CLICK ? 1 : 2;
        const profileNote = process.env.PARTY_PROFILE_FIRST_CLICK || process.env.PARTY_PROFILE_WARM_CLICK;
        if (tabProfiler && profileNote && index === profileClick) await tabProfiler.send("Profiler.start");
        await page.locator('.folder-query-view:not([aria-hidden="true"]) .note-preview').nth(index).click();
        await ready();
        if (tabProfiler && profileNote && index === profileClick) {
            const { profile } = await tabProfiler.send("Profiler.stop");
            await writeFile(
                process.env.PARTY_PROFILE_FIRST_CLICK
                    ? "/tmp/party-navigation-first-click.cpuprofile"
                    : "/tmp/party-navigation-warm-click.cpuprofile",
                JSON.stringify(profile)
            );
        }
    }
    if (!fullTrashImport && !process.env.PARTY_FIRST_TRASH_ONLY)
        await page.locator('.note-preview[aria-selected="true"]').focus();
    for (const key of fullTrashImport || process.env.PARTY_FIRST_TRASH_ONLY
        ? []
        : ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp", "ArrowUp", "ArrowUp", "ArrowUp"]) {
        await page.keyboard.press(key);
        await ready();
    }
} finally {
    const collected =
        fullTrashImport || process.env.PARTY_COLLECT_TRACES === "1"
            ? await page.evaluate(readTabTraces, "stop").catch((error) => ({ error: error.message }))
            : undefined;
    if (collected)
        await writeFile("/tmp/party-navigation-full-traces.json", JSON.stringify(collected, null, 2));
    const scheduler = await worker?.("globalThis.__partyStorageCounters?.timers");
    const native = await worker?.("globalThis.__partyStorageCounters?.stop()");
    const tab = await page.evaluate(readTabTraces).catch((error) => ({ error: error.message }));
    const records = await page.evaluate(
        (profileFirstClick) => ({
            records: window.navigationTiming,
            homeIds: window.navigationHomeIds,
            initialSources: window.navigationInitialSources,
            wire: window.navigationWire,
            path: location.pathname,
            focus: document.activeElement?.outerHTML,
            resources: profileFirstClick
                ? performance.getEntriesByType("resource").map((entry) => ({
                      path: new URL(entry.name).pathname,
                      start: entry.startTime,
                      duration: entry.duration,
                      initiator: entry.initiatorType,
                  }))
                : undefined,
        }),
        Boolean(process.env.PARTY_PROFILE_FIRST_CLICK)
    );
    records.configuration = {
        browserVersion: browser.version(),
        sqliteHost,
        browserChannel: process.env.PARTY_BROWSER_CHANNEL ?? "bundled-chromium",
        downloadOffline: process.env.PARTY_DOWNLOAD_OFFLINE === "1",
        disabledAfterDownload: process.env.PARTY_DISABLE_AFTER_DOWNLOAD === "1",
        idleAfterSetupMs,
        reloadedCachedTrash: process.env.PARTY_RELOAD_CACHED_TRASH === "1",
        storageCounters: process.env.PARTY_STORAGE_COUNTERS === "1",
        firstTrashProfile: Boolean(process.env.PARTY_PROFILE_FIRST_TRASH),
        warmClickProfile: Boolean(process.env.PARTY_PROFILE_WARM_CLICK),
        firstClickProfile: Boolean(process.env.PARTY_PROFILE_FIRST_CLICK),
        fullTrashImport,
    };
    records.scheduler = scheduler?.result?.value;
    await writeFile("/tmp/party-navigation-records.json", JSON.stringify(records, null, 2));
    await writeFile("/tmp/party-navigation-tab-traces.json", JSON.stringify(tab, null, 2));
    await writeFile(
        "/tmp/party-navigation-native.json",
        JSON.stringify(native?.result?.value ?? [], null, 2)
    );
    const parent = await page
        .evaluate(async () => {
            const { inspectWorker } = await import("/e2e/inspect-worker.ts");
            return inspectWorker(window.navigationWire.workerUrl);
        })
        .catch((error) => ({ error: error.message }));
    await writeFile("/tmp/party-navigation-worker-traces.json", JSON.stringify(parent, null, 2));
    console.log(
        JSON.stringify(
            records.records?.map(({ loads: _loads, rows: _rows, ...record }) => record),
            null,
            2
        )
    );
    await browser.close();
}
