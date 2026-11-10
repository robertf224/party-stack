// Production regression. A test-only reverse proxy holds new HTTP RPC requests;
// the app, worker, replica and Suspense queries run unchanged. This is not a timing
// benchmark. Fixtures are three empty folders, deleted again even on failure.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createSecureServer } from "node:http2";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const [base, keyPath, certPath] = process.argv.slice(2);
if (!base || !keyPath || !certPath)
    throw new Error("Pass the Notes production preview URL, local TLS key path and certificate path.");
const upstream = new URL(base);
const reportPath = process.env.PARTY_PENDING_REPORT ?? "/tmp/party-folder-pending.json";
const requests = new Set();
const held = new Set();
const holds = [];
let gate;
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
const forwardRequest = (request, response) => {
    const target = new URL(request.url ?? "/", upstream);
    const forward = () => {
        if (response.destroyed) return;
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
        outgoing.on("close", () => requests.delete(outgoing));
        outgoing.on("error", (error) => {
            if (!response.destroyed) {
                if (!response.headersSent) response.writeHead(502);
                response.end(error.message);
            }
        });
        response.on("close", () => outgoing.destroy());
        request.pipe(outgoing);
    };
    if (gate && target.pathname === "/api/ontology/rpc") {
        const entry = { forward, at: performance.now() };
        held.add(entry);
        response.once("close", () => held.delete(entry));
        gate.requests++;
        gate.blocked();
    } else forward();
};
// HTTP/1's six browser connections can all be occupied by real RPC watches.
// Keep the browser transport multiplexed, as in http2-benchmark-proxy.mjs.
// Only the fixture SDK uses the separate HTTP port (Node has no six-slot cap).
const proxy = createSecureServer(
    { key: await readFile(keyPath), cert: await readFile(certPath), allowHTTP1: true },
    forwardRequest
);
const sessions = new Set();
proxy.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
});
const fixtureProxy = http.createServer(forwardRequest);
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
fixtureProxy.listen(0, "127.0.0.1");
await once(fixtureProxy, "listening");
const address = proxy.address();
const fixtureAddress = fixtureProxy.address();
assert(address && typeof address !== "string");
assert(fixtureAddress && typeof fixtureAddress !== "string");
const origin = `https://127.0.0.1:${address.port}`;
const fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
const arm = (label) => {
    assert.equal(gate, undefined);
    let blocked;
    const firstRequest = new Promise((resolve) => {
        blocked = resolve;
    });
    gate = { label, at: performance.now(), requests: 0, blocked, firstRequest };
};
const release = () => {
    if (!gate) return;
    holds.push({ label: gate.label, requests: gate.requests, durationMs: performance.now() - gate.at });
    gate = undefined;
    for (const entry of held) entry.forward();
    held.clear();
};
async function waitForHeldRequest() {
    assert(gate);
    let timeout;
    try {
        await Promise.race([
            gate.firstRequest,
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("The cold destination did not issue an HTTP RPC request.")),
                    15_000
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

let browser;
let profile;
let sdk;
let page;
const errors = [];
const checkpoints = [];
const created = [];
const suffix = crypto.randomUUID().slice(0, 8);
const folders = ["A", "B", "C"].map((letter) => ({
    id: crypto.randomUUID(),
    // Same prefix keeps these adjacent in the real alphabetically sorted list.
    name: `Pending ${suffix} ${letter}`,
}));
let failure;
try {
    sdk = await createLiveOntology({ client: httpClient(`${fixtureOrigin}/api/ontology/rpc`) });
    for (const folder of folders) {
        await sdk.actions.createNotebook({ ...folder, color: "#829bbc" });
        created.push(folder.id);
    }
    console.log("Created three empty test folders.");
    // SharedWorker/OPFS startup uses a normal isolated profile, matching the
    // offline-startup harness. The profile is removed after this regression.
    profile = await mkdtemp(join(tmpdir(), "party-folder-pending-"));
    const context = await chromium.launchPersistentContext(profile, {
        ...(process.env.PARTY_BROWSER_CHANNEL ? { channel: process.env.PARTY_BROWSER_CHANNEL } : {}),
        headless: true,
        viewport: { width: 1440, height: 960 },
        colorScheme: "dark",
        // This context trusts only this test's disposable self-signed endpoint.
        // Upstream TLS verification still follows PARTY_INSECURE_LOCAL_TLS.
        ignoreHTTPSErrors: true,
    });
    browser = context.browser();
    context.setDefaultTimeout(35_000);
    page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") console.log("PAGE CONSOLE:", message.text());
    });
    page.on("requestfailed", (request) =>
        console.log("REQUEST FAILED:", new URL(request.url()).pathname, request.failure()?.errorText)
    );
    await page.addInitScript(() => {
        const state = (window.folderPendingAudit = { stage: "startup", samples: [] });
        const read = () => {
            const list = document.querySelector(".note-list");
            const content = list?.querySelector(".folder-query-view");
            const scroller = content?.querySelector(".note-list-scroll-area");
            const editor = document.querySelector(".workspace-body");
            const active = document.activeElement;
            return {
                stage: state.stage,
                path: location.pathname,
                selected: document.querySelector('.sidebar a[aria-current="page"]')?.getAttribute("href"),
                heading: list?.querySelector(".list-heading h1")?.textContent?.trim(),
                rows: [...(content?.querySelectorAll(".note-preview") ?? [])].map(
                    (row) => row.dataset.noteId
                ),
                busy: list?.getAttribute("aria-busy") === "true",
                pending: content?.hasAttribute("data-navigation-pending") ?? false,
                opacity: scroller ? Number(getComputedStyle(scroller).opacity) : undefined,
                headingZ: list?.querySelector(".list-heading")
                    ? Number(getComputedStyle(list.querySelector(".list-heading")).zIndex)
                    : undefined,
                glassZ: document.querySelector(".notes-app")
                    ? Number(getComputedStyle(document.querySelector(".notes-app"), "::before").zIndex)
                    : undefined,
                listOpacity: list ? Number(getComputedStyle(list).opacity) : undefined,
                appOpacity: document.querySelector(".notes-app")
                    ? Number(getComputedStyle(document.querySelector(".notes-app")).opacity)
                    : undefined,
                contentOpacity: content ? Number(getComputedStyle(content).opacity) : undefined,
                headingOpacity: list?.querySelector(".list-heading")
                    ? Number(getComputedStyle(list.querySelector(".list-heading")).opacity)
                    : undefined,
                editorPending: editor?.hasAttribute("data-navigation-pending") ?? false,
                focus: active?.getAttribute("href") ?? active?.getAttribute("data-note-id"),
            };
        };
        state.read = read;
        let previous;
        const sample = () => {
            const value = read();
            const identity = JSON.stringify(value);
            if (identity !== previous) {
                state.samples.push({ at: performance.now(), ...value });
                previous = identity;
            }
        };
        new MutationObserver(sample).observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
        const frame = () => {
            sample();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
    await page.goto(origin);
    assert.equal(
        await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.nextHopProtocol),
        "h2",
        "Streaming RPC requests require the test proxy's HTTP/2 browser transport"
    );
    await page.locator(".note-list .note-preview").first().waitFor();
    const sidebar = page.locator(".sidebar");
    if (!(await sidebar.getByRole("link", { name: "Notes", exact: true }).isVisible()))
        await page.getByRole("button", { name: "Show folders", exact: true }).click();
    for (const folder of folders)
        await sidebar.getByRole("link", { name: folder.name, exact: true }).waitFor();

    const snapshot = () => page.evaluate(() => window.folderPendingAudit.read());
    const stage = (name) => {
        console.log("Stage:", name);
        return page.evaluate((value) => (window.folderPendingAudit.stage = value), name);
    };
    const settled = async (heading, path) => {
        await page.waitForFunction(
            ({ heading, path }) => {
                const state = window.folderPendingAudit.read();
                return state.heading === heading && state.path === path && !state.busy;
            },
            { heading, path }
        );
        const state = await snapshot();
        assert.equal(state.pending, false);
        assert.equal(state.editorPending, false);
        return state;
    };
    const assertPending = async (selected, previous) => {
        await page.waitForFunction((href) => {
            const state = window.folderPendingAudit.read();
            return state.selected === href && state.busy && state.pending && state.opacity < 0.9;
        }, selected);
        const state = await snapshot();
        assert.equal(state.heading, previous.heading, "Pending navigation must retain the committed heading");
        assert(
            state.headingOpacity >= 0.55 && state.headingOpacity < 0.9,
            "The retained folder heading dims with the list without disappearing"
        );
        assert.deepEqual(state.rows, previous.rows, "Pending navigation must retain that heading's rows");
        assert.equal(
            state.editorPending,
            true,
            "The previous editor should also indicate pending navigation"
        );
        assert(state.headingZ > state.glassZ, "Header must remain above the shared glass surface");
        assert.equal(state.listOpacity, 1, "List ancestor must not create an opacity stacking context");
        assert.equal(state.contentOpacity, 1, "Fragment wrapper must not create an opacity stacking context");
        assert.equal(state.appOpacity, 1);
        if (!checkpoints.length)
            await page.screenshot({ path: reportPath.replace(/\.json$/, "") + "-pending.png" });
        checkpoints.push(state);
    };
    const notes = await settled("Notes", "/");
    assert(notes.rows.length > 0, "The existing default Notes folder needs one row for the focus guard");

    await stage("cold-A");
    arm("test-controlled HTTP RPC hold: cold A→B→C");
    const firstFolder = sidebar.getByRole("link", { name: folders[0].name, exact: true });
    await firstFolder.click();
    await firstFolder.focus();
    await waitForHeldRequest();
    await assertPending(`/folders/${folders[0].id}`, notes);
    // A pending folder's old rows are visible, but ArrowRight must not open one.
    const pendingPath = (await snapshot()).path;
    await page.keyboard.press("ArrowRight");
    let state = await snapshot();
    assert.equal(state.focus, `/folders/${folders[0].id}`);
    assert.equal(state.path, pendingPath, "ArrowRight must not navigate to a previous folder's note");
    assert.equal(await page.locator(".note-page").count(), 0);

    for (const folder of folders.slice(1)) {
        await stage(`rapid-${folder.name.at(-1)}`);
        await page.keyboard.press("ArrowDown");
        await assertPending(`/folders/${folder.id}`, notes);
        state = await snapshot();
        assert.equal(state.focus, `/folders/${folder.id}`);
    }
    release();
    await settled(folders[2].name, `/folders/${folders[2].id}`);
    assert.deepEqual((await snapshot()).rows, [], "Only the final empty folder should commit");

    await stage("return-Notes");
    await sidebar.getByRole("link", { name: "Notes", exact: true }).click();
    const backToNotes = await settled("Notes", "/");
    assert.deepEqual(backToNotes.rows, notes.rows);

    // Exercise the other route family under the same real network boundary.
    await stage("cold-Trash");
    arm("test-controlled HTTP RPC hold: cold Trash");
    await sidebar.getByRole("link", { name: "Recently deleted", exact: true }).click();
    await waitForHeldRequest();
    await assertPending("/trash", backToNotes);
    // Cancel that destination before its live query becomes ready.
    await stage("cancel-Trash-with-Notes");
    await sidebar.getByRole("link", { name: "Notes", exact: true }).click();
    await settled("Notes", "/");
    release();

    let trashRows;
    for (let i = 0; i < 2; i++) {
        await stage(`Notes-to-Trash-${i}`);
        await sidebar.getByRole("link", { name: "Recently deleted", exact: true }).click();
        const trash = await settled("Recently deleted", "/trash");
        assert(
            trash.rows.every((id) => !notes.rows.includes(id)),
            "Trash must not display active Notes rows"
        );
        trashRows = trash.rows;
        await stage(`Trash-to-Notes-${i}`);
        await sidebar.getByRole("link", { name: "Notes", exact: true }).click();
        assert.deepEqual((await settled("Notes", "/")).rows, notes.rows);
    }
    const frames = await page.evaluate(() => window.folderPendingAudit.samples);
    const expectedRows = new Map([
        ["Notes", notes.rows],
        ["Recently deleted", trashRows],
        [folders[2].name, []],
    ]);
    for (const frame of frames.filter((frame) => frame.stage !== "startup")) {
        assert(expectedRows.has(frame.heading), `A superseded folder committed: ${frame.heading}`);
        assert.deepEqual(
            frame.rows,
            expectedRows.get(frame.heading),
            `Heading/rows diverged during ${frame.stage}`
        );
        assert.equal(frame.busy, frame.pending, "Busy and dimmed state must have the same owner");
        assert.equal(frame.busy, frame.editorPending);
    }
    assert.deepEqual(errors, []);
    console.log(
        "PASS: immediate destination selection, coherent dimmed pending content, rapid folder keys, focus guard and Notes↔Trash"
    );
} catch (error) {
    failure = error;
    await page?.screenshot({ path: reportPath.replace(/\.json$/, "") + "-failure.png" }).catch(() => {});
} finally {
    release();
    const samples = await page?.evaluate(() => window.folderPendingAudit?.samples).catch(() => []);
    const cleanupErrors = [];
    await browser?.close().catch((error) => cleanupErrors.push({ message: String(error) }));
    if (profile)
        await rm(profile, { recursive: true, force: true }).catch((error) =>
            cleanupErrors.push({ message: String(error) })
        );
    for (const id of created) {
        try {
            await sdk.actions.deleteNotebook({ notebook: id });
        } catch (error) {
            cleanupErrors.push({ id, message: String(error) });
        }
    }
    await sdk?.cleanup().catch((error) => cleanupErrors.push({ message: String(error) }));
    for (const request of requests) request.destroy();
    fixtureProxy.closeAllConnections();
    await new Promise((resolve) => fixtureProxy.close(resolve));
    // Closing the browser closes its HTTP/2 session before this server close.
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await writeFile(
        reportPath,
        JSON.stringify(
            { controlledNetworkHold: true, errors, holds, checkpoints, samples, cleanupErrors },
            null,
            2
        )
    );
    if (cleanupErrors.length) {
        console.error("Fixture cleanup failed:", cleanupErrors);
        failure ??= new Error("Could not delete all empty test folders; see the report.");
    }
}
if (failure) throw failure;
