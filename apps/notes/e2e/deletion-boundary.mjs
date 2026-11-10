// Desktop deletion regression, with detailed capture for root remounts and splash returns.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createLiveOntology } from "@party-stack/ontology";
import { httpClient } from "@party-stack/ontology/http";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL and optional HTTP RPC URL.");
const sdk = await createLiveOntology({
    client: httpClient(process.argv[3] ?? "http://127.0.0.1:5176/api/ontology/rpc"),
});
const browser = await chromium.launch(
    process.env.PARTY_BROWSER_CHANNEL ? { channel: process.env.PARTY_BROWSER_CHANNEL } : {}
);
const mobile = process.env.PARTY_DELETION_MOBILE === "1";
const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    colorScheme: "dark",
    ignoreHTTPSErrors: process.env.PARTY_INSECURE_LOCAL_TLS === "1",
});
context.setDefaultTimeout(15_000);
const page = await context.newPage();
const errors = [];
const events = [];
await context.exposeBinding("__recordDeletionBoundary", (_source, event) => {
    events.push({ ...event, hostAt: Date.now() });
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
        events.push({ type: "console", level: message.type(), text: message.text(), at: Date.now() });
});
page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) events.push({ type: "navigation", url: frame.url(), at: Date.now() });
});
page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
        try {
            const value = JSON.parse(String(payload));
            events.push({
                type: "websocket",
                url: socket.url(),
                messageType: value.type,
                event: value.event,
                paths: value.updates?.map((update) => update.path),
                error: value.err?.message,
                at: Date.now(),
            });
        } catch {
            /* Ignore non-JSON, non-HMR messages. */
        }
    });
});
const folder = crypto.randomUUID();
const otherFolder = crypto.randomUUID();
const ids = [];
const createdFolders = [];
const reportPath = process.env.PARTY_DELETION_REPORT ?? "/tmp/party-deletion-boundary.json";

await page.addInitScript(() => {
    const documentId = crypto.randomUUID();
    const record = (value) => {
        void window.__recordDeletionBoundary({ ...value, documentId, at: performance.now() }).catch(() => {});
    };
    record({
        type: "document-created",
        origin: performance.timeOrigin,
        url: location.href,
        viewport: { width: innerWidth, height: innerHeight },
        userAgent: navigator.userAgent,
    });
    const state = (window.deletionBoundary = {
        documentId,
        operations: [],
        active: undefined,
        unhandled: [],
    });
    window.addEventListener("pagehide", () => record({ type: "pagehide", active: state.active }));
    const identities = new WeakMap();
    let nextIdentity = 0;
    const identity = (node) => {
        if (!node) return undefined;
        if (!identities.has(node)) identities.set(node, ++nextIdentity);
        return identities.get(node);
    };
    window.addEventListener("unhandledrejection", (event) =>
        state.unhandled.push({
            at: performance.now(),
            message: event.reason?.message ?? String(event.reason),
            stack: event.reason?.stack,
        })
    );
    const identify = (node) => ({
        tag: node.tagName,
        class: String(node.className),
        noteId: node.dataset?.noteId,
    });
    const styles = (node) => {
        const result = [];
        for (let current = node; current instanceof Element; current = current.parentElement) {
            const style = getComputedStyle(current);
            result.push({
                ...identify(current),
                inline: current.getAttribute("style"),
                rects: current.getClientRects().length,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                contentVisibility: style.contentVisibility,
                viewTransitionName: style.viewTransitionName,
            });
        }
        return result;
    };
    const fiberPath = (node) => {
        const property = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
        const result = [];
        for (let fiber = node[property]; fiber && result.length < 30; fiber = fiber.return) {
            const type = fiber.type;
            result.push({
                tag: fiber.tag,
                name: typeof type === "string" ? type : (type?.displayName ?? type?.name),
                suspended: fiber.tag === 13 ? fiber.memoizedState !== null : undefined,
            });
        }
        return result;
    };
    const transition = () => {
        let active;
        try {
            active = document.documentElement.matches(":active-view-transition");
        } catch {
            active = undefined;
        }
        return {
            active,
            documentTransition: !!document.activeViewTransition,
            animations: document
                .getAnimations()
                .filter((animation) => animation.effect?.pseudoElement?.includes("view-transition"))
                .map((animation) => ({ pseudo: animation.effect.pseudoElement, state: animation.playState })),
        };
    };
    const snapshot = () => {
        const workspace = document.querySelector(".boot-workspace");
        const app = document.querySelector(".notes-app");
        return {
            at: performance.now(),
            path: location.pathname,
            transition: transition(),
            workspace: workspace ? styles(workspace) : [],
            workspaceIdentity: identity(workspace),
            app: app ? styles(app) : [],
            fiber: app ? fiberPath(app) : [],
            fallbacks: [
                ...document.querySelectorAll(
                    '.opening,.preview-skeleton,.editor-loading,[aria-label="Opening folder"],[aria-label="Opening note"]'
                ),
            ].map((node) => ({
                ...identify(node),
                label: node.getAttribute("aria-label"),
                styles: styles(node),
                fiber: fiberPath(node),
                insideEditor: !!node.closest(".note-main"),
            })),
        };
    };
    const hidden = (chain) =>
        !chain.length ||
        chain.some(
            (node) =>
                !node.rects ||
                node.display === "none" ||
                node.visibility !== "visible" ||
                Number(node.opacity) === 0
        );
    state.sample = (reason) => {
        const current = state.active;
        if (!current) return;
        current.samples++;
        const workspace = document.querySelector(".boot-workspace");
        const app = document.querySelector(".notes-app");
        const workspaceIdentity = identity(workspace);
        if (workspaceIdentity !== current.workspaceIdentity) {
            record({
                type: "workspace-identity",
                previous: current.workspaceIdentity,
                next: workspaceIdentity,
                operation: current.label,
            });
            current.workspaceIdentity = workspaceIdentity;
        }
        const isHidden = hidden(workspace ? styles(workspace) : []) || hidden(app ? styles(app) : []);
        const opening = [...document.querySelectorAll('.opening[aria-label="Opening"]')].some(
            (node) => !hidden(styles(node))
        );
        if (isHidden || opening) {
            const frame = snapshot();
            frame.reason = reason;
            frame.elapsed = frame.at - current.start;
            if (isHidden) current.hidden.push(frame);
            if (opening) current.splashes.push(frame);
            if (opening && !current.splashReported) {
                current.splashReported = true;
                record({ type: "splash-observed", frame });
            }
        }
        if (reason === "frame") current.frames++;
    };
    // Observe React's hideInstance call without changing style values or timing.
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (...args) {
        const result = setProperty.apply(this, args);
        if (state.active && ["display", "visibility"].includes(args[0])) {
            const node = [
                ...document.querySelectorAll(
                    "html,body,.boot-workspace,.notes-app,.note-list,.folder-query-view,.note-main,.workspace-body,.note-page"
                ),
            ].find((node) => node.style === this);
            if (node) {
                state.active.styleChanges.push({
                    at: performance.now() - state.active.start,
                    node: identify(node),
                    args,
                    stack: new Error().stack?.split("\n").slice(1, 14),
                    fiber: fiberPath(node),
                });
                queueMicrotask(() => state.sample("style"));
            }
        }
        return result;
    };
    new MutationObserver(() => state.sample("mutation")).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden"],
    });
    state.begin = (label, id) => {
        state.active = {
            label,
            id,
            start: performance.now(),
            initial: snapshot(),
            workspaceIdentity: identity(document.querySelector(".boot-workspace")),
            samples: 0,
            frames: 0,
            hidden: [],
            splashes: [],
            styleChanges: [],
        };
    };
    state.finish = () => {
        state.sample("finish");
        const current = state.active;
        current.durationMs = performance.now() - current.start;
        state.operations.push(current);
        state.active = undefined;
        return current;
    };
    const frame = () => {
        state.sample("frame");
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
});

async function editor(id) {
    await page.waitForURL((url) => url.pathname.endsWith(`/${id}`));
    const target = page.locator(`.note-page[data-note-id="${id}"] [aria-label="Note content"]`);
    await target.waitFor();
    return target;
}
async function remove(id, menu) {
    const target = page.locator(`.note-preview[data-note-id="${id}"]`);
    if (!new URL(page.url()).pathname.endsWith(`/${id}`)) await target.click();
    await editor(id);
    if (process.env.PARTY_DELETE_SETTLE === "1")
        await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"));
    const listed = await page
        .locator(".note-preview")
        .evaluateAll((rows) => rows.map((node) => node.dataset.noteId));
    const index = listed.indexOf(id);
    const next = listed[index + 1] ?? listed[index - 1];
    await page.evaluate(
        ({ id, menu, mobile, next }) =>
            window.deletionBoundary.begin(
                mobile
                    ? "mobile menu deletion"
                    : !next
                      ? "last-note keyboard deletion"
                      : menu
                        ? "context deletion"
                        : "keyboard deletion",
                id
            ),
        { id, menu, mobile, next }
    );
    if (menu || mobile) {
        if (mobile) await page.getByRole("button", { name: "Note options", exact: true }).click();
        else await target.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Delete note", exact: true }).click();
    } else {
        await target.focus();
        await target.press("Backspace");
    }
    await target.waitFor({ state: mobile ? "detached" : "hidden" });
    if (mobile || !next) {
        await page.waitForURL((url) => url.pathname === `/folders/${folder}`);
        await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    } else await editor(next);
    await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"));
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const operation = await page.evaluate(() => window.deletionBoundary.finish());
    console.log(
        operation.label,
        JSON.stringify({
            durationMs: operation.durationMs,
            frames: operation.frames,
            hidden: operation.hidden.length,
            splashes: operation.splashes.length,
            styleChanges: operation.styleChanges.length,
        })
    );
}

try {
    await sdk.actions.createNotebook({
        id: folder,
        name: `Deletion boundary ${folder.slice(0, 8)}`,
        color: "#829bbc",
    });
    createdFolders.push(folder);
    await sdk.actions.createNotebook({
        id: otherFolder,
        name: `Deletion other ${folder.slice(0, 8)}`,
        color: "#829bbc",
    });
    createdFolders.push(otherFolder);
    await sdk.actions.createNote({
        id: crypto.randomUUID(),
        notebookId: otherFolder,
        kind: "note",
        title: "Other boundary note",
    });
    for (let i = 0; i < 5; i++) {
        const id = crypto.randomUUID();
        await sdk.actions.createNote({ id, notebookId: folder, kind: "note", title: `Boundary note ${i}` });
        ids.push(id);
    }
    await page.goto(new URL(`/folders/${folder}`, base).href);
    await page.locator(`.note-preview[data-note-id="${ids[0]}"]`).waitFor();
    await page.waitForFunction(
        () => document.querySelector(".boot-workspace")?.style.visibility === "visible"
    );
    for (const id of mobile ? [] : [otherFolder, folder, otherFolder, folder]) {
        await page.locator(`.sidebar a[href="/folders/${id}"]`).click();
        await page.waitForURL((url) => url.pathname === `/folders/${id}`);
        await page
            .getByRole("heading", {
                name:
                    id === folder
                        ? `Deletion boundary ${folder.slice(0, 8)}`
                        : `Deletion other ${folder.slice(0, 8)}`,
                exact: true,
            })
            .waitFor();
        await page.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
    }
    // Match the reported sequence: create and type, then immediately delete it.
    await page.getByRole("button", { name: "New note", exact: true }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "Note", exact: true }).click();
    await page.waitForURL(
        (url) =>
            url.pathname.startsWith(`/folders/${folder}/`) && !ids.some((id) => url.pathname.endsWith(id))
    );
    const created = new URL(page.url()).pathname.split("/").at(-1);
    ids.push(created);
    await (await editor(created)).fill(`Delete boundary ${folder.slice(0, 8)}`);
    await page
        .locator(`.note-preview[data-note-id="${created}"]`)
        .filter({ hasText: `Delete boundary ${folder.slice(0, 8)}` })
        .waitFor({ state: "attached" });
    await remove(created, false);
    await remove(ids[1], true);
    await remove(ids[2], false);
    if (!mobile) {
        while (await page.locator(".note-preview").count()) {
            const last = await page.locator(".note-preview").first().getAttribute("data-note-id");
            assert(ids.includes(last), "Delete only owned notes");
            await remove(last, false);
        }
    }
    assert.deepEqual(errors, []);
    if (process.env.PARTY_DELETION_CAPTURE_ONLY !== "1") {
        const operations = await page.evaluate(() => window.deletionBoundary.operations);
        for (const operation of operations) {
            assert.equal(operation.hidden.length, 0, `${operation.label}: workspace became hidden`);
            assert.equal(operation.splashes.length, 0, `${operation.label}: opening splash returned`);
            assert.equal(
                operation.workspaceIdentity,
                operation.initial.workspaceIdentity,
                `${operation.label}: workspace remounted`
            );
        }
        const routeErrors = events.filter(
            (event) =>
                event.type === "console" && event.level === "error" && event.text.includes("MatchInnerImpl")
        );
        assert.deepEqual(routeErrors, [], "Deletion must not recover through the root route error boundary");
    }
} catch (error) {
    await page.screenshot({ path: "/tmp/party-deletion-boundary-failure.png" }).catch(() => {});
    throw error;
} finally {
    const report = await page
        .evaluate(() => {
            const state = window.deletionBoundary;
            return state
                ? [...state.operations, ...(state.active ? [{ ...state.active, incomplete: true }] : [])]
                : [];
        })
        .catch(() => []);
    await writeFile(
        reportPath,
        JSON.stringify(
            {
                errors,
                events,
                browser: { version: browser.version(), viewport: page.viewportSize(), url: page.url() },
                unhandled: await page.evaluate(() => window.deletionBoundary?.unhandled).catch(() => []),
                operations: report,
            },
            null,
            2
        )
    );
    await browser.close();
    try {
        for (const id of createdFolders) await sdk.actions.deleteNotebook({ notebook: id });
    } finally {
        await sdk.cleanup();
    }
}
