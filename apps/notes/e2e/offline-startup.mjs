// Cached-startup regression, not an offline assets/service-worker test. A real
// HTTP/2 reverse proxy serves application assets normally, but rejects every
// /api/ontology request after the disposable browser has downloaded its graph.
// Closing/relaunching the entire persistent context guarantees a cold worker.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createSecureServer } from "node:http2";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";
import { readTabTraces } from "./storage-counters.mjs";

const [
    base,
    keyPath = "/tmp/party-notes-sqlite-opfs/localhost-key.pem",
    certPath = "/tmp/party-notes-sqlite-opfs/localhost-cert.pem",
] = process.argv.slice(2);
if (!base)
    throw new Error("Pass the Notes preview URL, optionally followed by local TLS key/certificate paths.");
const upstream = new URL(base);
const prefix = process.env.PARTY_OFFLINE_STARTUP_REPORT ?? "/tmp/party-notes-offline-startup";
const profile = await mkdtemp(join(tmpdir(), "party-notes-offline-startup-"));
const requests = new Set(),
    sessions = new Set();
const network = [],
    errors = [],
    consoleErrors = [];
let phase = "populate",
    context,
    page,
    proxy,
    failure;
const report = {
    url: base,
    mode: "cold-worker-retained-durable-cache",
    upstreamAssetsAvailable: true,
    backendBlockedByTestProxy: false,
    passed: false,
};
const stripHeaders = (headers) =>
    Object.fromEntries(
        Object.entries(headers).filter(
            ([key]) =>
                !key.startsWith(":") &&
                !["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"].includes(
                    key
                )
        )
    );
const isBackend = (path) => path === "/api/ontology" || path.startsWith("/api/ontology/");
const tagsFrom = (body) => {
    const tags = [];
    const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value?._tag === "Request" && typeof value.tag === "string") tags.push(value.tag);
    };
    for (const line of body.split("\n").filter(Boolean)) {
        try {
            visit(JSON.parse(line));
        } catch {
            /* Partial/aborted bodies carry no inferred tags. */
        }
    }
    return tags;
};
const digest = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const snapshot = () =>
    [...document.querySelectorAll('.folder-query-view:not([aria-hidden="true"]) .note-preview')].map(
        (row) => ({
            id: row.dataset.noteId,
            title: row.querySelector(".preview-title strong")?.textContent ?? "",
        })
    );
async function launch() {
    context = await chromium.launchPersistentContext(profile, {
        channel: process.env.PARTY_BROWSER_CHANNEL ?? "chrome",
        headless: true,
        viewport: { width: 1440, height: 960 },
        colorScheme: "dark",
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
    });
    context.setDefaultTimeout(30_000);
    const browser = context.browser();
    assert(browser, "The persistent context must expose its browser");
    report.browser = browser.version();
    const protocol = await browser.newBrowserCDPSession();
    try {
        const { targetInfos } = await protocol.send("Target.getTargets");
        const workers = targetInfos.filter((target) => target.type === "shared_worker");
        assert.equal(workers.length, 0, "No SharedWorker may survive a full browser restart");
        if (phase === "offline") report.sharedWorkersBeforeOfflineBoot = workers.length;
    } finally {
        await protocol.detach();
    }
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push({ phase, message: error.message }));
    page.on("console", (message) => {
        if (message.type() === "error" && consoleErrors.length < 50)
            consoleErrors.push({ phase, message: message.text() });
    });
    return page;
}
async function waitForNotes() {
    await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    await page
        .locator('.folder-query-view:not([aria-hidden="true"]) .note-preview')
        .first()
        .waitFor({ state: "visible" });
    await page.waitForFunction(
        () => document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true"
    );
}
try {
    proxy = createSecureServer(
        { key: await readFile(keyPath), cert: await readFile(certPath), allowHTTP1: true },
        (request, response) => {
            const target = new URL(request.url ?? "/", upstream);
            const blocked = phase === "offline" && isBackend(target.pathname);
            const record = {
                phase,
                at: Date.now(),
                path: target.pathname,
                method: request.method,
                blocked,
                probe: request.headers["x-party-offline-probe"] === "1",
                tags: [],
            };
            if (isBackend(target.pathname)) {
                network.push(record);
                let body = "";
                request.on("data", (chunk) => {
                    if (body.length < 256 * 1024) body += chunk.toString("utf8");
                });
                request.on("end", () => {
                    record.tags = tagsFrom(body);
                });
            }
            if (blocked) {
                // Reject all backend endpoints, including watches and attachments;
                // asset/module requests continue through the ordinary upstream.
                request.on("end", () => {
                    if (!response.destroyed) {
                        response.writeHead(503, {
                            "content-type": "text/plain",
                            "cache-control": "no-store",
                        });
                        response.end("Test backend unavailable");
                    }
                });
                request.resume();
                return;
            }
            const outgoing = (target.protocol === "https:" ? https : http).request(
                target,
                {
                    method: request.method,
                    headers: { ...stripHeaders(request.headers), host: target.host },
                    agent: false,
                    ...(target.protocol === "https:"
                        ? { rejectUnauthorized: process.env.PARTY_INSECURE_LOCAL_TLS !== "1" }
                        : {}),
                },
                (incoming) => {
                    response.writeHead(incoming.statusCode ?? 502, stripHeaders(incoming.headers));
                    incoming.pipe(response);
                }
            );
            requests.add(outgoing);
            outgoing.once("close", () => requests.delete(outgoing));
            outgoing.on("error", () => {
                if (!response.destroyed) {
                    if (!response.headersSent) response.writeHead(502);
                    response.end("Test proxy upstream failed");
                }
            });
            response.once("close", () => outgoing.destroy());
            request.pipe(outgoing);
        }
    );
    proxy.on("session", (session) => {
        sessions.add(session);
        session.once("close", () => sessions.delete(session));
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert(address && typeof address !== "string");
    const origin = `https://127.0.0.1:${address.port}`;
    report.testOrigin = origin;
    await launch();
    await page.goto(origin);
    assert.equal(
        await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.nextHopProtocol),
        "h2",
        "The browser transport must multiplex long RPC streams"
    );
    await waitForNotes();
    await setFolderDownload(page, true);
    const saved = await page.evaluate(snapshot);
    assert(saved.length > 0, "This read-only fixture needs an existing note in the default Notes folder");
    report.saved = { rows: saved.length, digest: digest(saved) };
    assert(
        network.some((request) => request.phase === "populate" && request.tags.includes("Describe")),
        "The warm phase must demonstrate that upstream RPC tags are observable"
    );
    await context.close();
    context = undefined;
    phase = "offline";
    report.backendBlockedByTestProxy = true;
    await launch();
    const verification = await context.request.get(`${origin}/api/ontology/rpc`, {
        headers: { "x-party-offline-probe": "1" },
    });
    assert.equal(verification.status(), 503, "The upstream ontology endpoint must actually be unavailable");
    await page.addInitScript(() => {
        const timing = (window.offlineStartup = {
            timeOrigin: performance.timeOrigin,
            localRpc: [],
            dom: [],
        });
        const nativePost = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (...args) {
            const record = (value) => {
                if (Array.isArray(value)) return value.forEach(record);
                if (value?._tag === "Request")
                    timing.localRpc.push({ at: performance.now(), tag: value.tag });
            };
            record(args[0]);
            return nativePost.apply(this, args);
        };
        const NativeSharedWorker = globalThis.SharedWorker;
        globalThis.SharedWorker = new Proxy(NativeSharedWorker, {
            construct(target, args) {
                timing.workerAcquisitionAt ??= performance.now();
                return Reflect.construct(target, args);
            },
        });
        const rows = () => [
            ...document.querySelectorAll('.folder-query-view:not([aria-hidden="true"]) .note-preview'),
        ];
        const observe = () => {
            if (rows().length) timing.rowsDOMAt ??= performance.now();
        };
        new MutationObserver(observe).observe(document, { childList: true, subtree: true });
        addEventListener("DOMContentLoaded", () => {
            timing.domContentLoadedAt = performance.now();
        });
        addEventListener("load", () => {
            timing.windowLoadedAt = performance.now();
        });
        const frame = () => {
            const current = rows();
            if (
                current.length &&
                getComputedStyle(current[0]).visibility === "visible" &&
                document.querySelector(".note-list")?.getAttribute("aria-busy") !== "true"
            ) {
                timing.rowsVisibleAt = performance.now();
                requestAnimationFrame(() => {
                    timing.paintAt = performance.now();
                });
            } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
    const navigationAt = Date.now();
    await page.goto(origin);
    await waitForNotes();
    await page.waitForFunction(() => window.offlineStartup?.paintAt !== undefined);
    const restored = await page.evaluate(snapshot);
    assert.deepEqual(
        restored,
        saved,
        "The fresh tab must render the downloaded note values from the cold worker's durable cache"
    );
    report.restored = { rows: restored.length, digest: digest(restored) };
    report.timing = await page.evaluate(() => window.offlineStartup);
    report.timing.navigationWallMs = Date.now() - navigationAt;
    const { workerAcquisitionAt, rowsDOMAt, rowsVisibleAt, paintAt, windowLoadedAt } = report.timing;
    report.timing.workerToDOMMs = rowsDOMAt - workerAcquisitionAt;
    report.timing.workerToVisibleMs = rowsVisibleAt - workerAcquisitionAt;
    report.timing.workerToPaintMs = paintAt - workerAcquisitionAt;
    report.timing.windowLoadedToDOMMs = windowLoadedAt === undefined ? undefined : rowsDOMAt - windowLoadedAt;
    const traces = await page.evaluate(readTabTraces);
    await writeFile(`${prefix}-traces.json`, JSON.stringify(traces, null, 2));
    // Finish the observation window before counting requests so a backend call
    // issued just after the first visible frame is not omitted from the report.
    await context.close();
    context = undefined;
    const offline = network.filter((request) => request.phase === "offline" && !request.probe);
    assert(
        offline.every((request) => request.blocked),
        "No backend request may be forwarded during offline startup"
    );
    report.upstream = {
        warmRequests: network.filter((request) => request.phase === "populate").length,
        offlineRequests: offline.length,
        offlineDescribe: offline.flatMap((request) => request.tags).filter((tag) => tag === "Describe")
            .length,
    };
    assert.equal(
        report.upstream.offlineDescribe,
        0,
        "Retained startup must not issue an upstream Describe preflight"
    );
    assert.deepEqual(errors, [], "Cached startup must not produce uncaught page errors");
    report.passed = true;
    console.log(
        `PASS: ${restored.length} cached notes rendered after a full browser restart with all backend routes unavailable; zero upstream Describe calls.`
    );
    console.log(
        JSON.stringify(
            {
                report: `${prefix}.json`,
                browser: report.browser,
                rows: restored.length,
                timing: report.timing,
                upstream: report.upstream,
            },
            null,
            2
        )
    );
} catch (error) {
    failure = error;
    report.failure = { message: error.message, stack: error.stack };
    report.lastTiming = await page?.evaluate(() => window.offlineStartup).catch(() => undefined);
    if (phase === "offline") {
        const traces = await page?.evaluate(readTabTraces).catch((error) => ({ error: error.message }));
        await writeFile(`${prefix}-failure-traces.json`, JSON.stringify(traces ?? {}, null, 2));
    }
} finally {
    await context?.close();
    for (const request of requests) request.destroy();
    for (const session of sessions) session.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await rm(profile, { recursive: true, force: true });
    await writeFile(`${prefix}.json`, JSON.stringify({ ...report, network, errors, consoleErrors }, null, 2));
}
if (failure) throw failure;
