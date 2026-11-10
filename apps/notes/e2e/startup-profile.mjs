import { writeFile } from "node:fs/promises";
import { ClientViewCodec } from "@party-stack/ontology-backend/protocol";
import { Schema } from "effect";
import { chromium } from "playwright";
import { setFolderDownload } from "./downloads.mjs";
import { readTabTraces } from "./storage-counters.mjs";

const base = process.argv[2];
if (!base) throw new Error("Pass the Notes preview URL.");
const trashBoot = process.env.PARTY_BOOT_TRASH === "1";
const populatedWorker = trashBoot && process.env.PARTY_DOWNLOAD_OFFLINE === "1";
const browser = await chromium.launch(
    process.env.PARTY_BROWSER_CHANNEL ? { channel: process.env.PARTY_BROWSER_CHANNEL } : {}
);
console.log("Browser:", browser.version(), process.env.PARTY_BROWSER_CHANNEL ?? "bundled-chromium");
const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "dark",
    reducedMotion: process.env.PARTY_REDUCED_MOTION === "1" ? "reduce" : "no-preference",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(`globalThis.readBootTraces = (${readTabTraces.toString()});`);
await page.addInitScript(
    (transitionDetails) => {
        const audit = (window.startupProfile = { checkpoints: {}, rpc: [], messages: [], transitions: [] });
        performance.setResourceTimingBufferSize(2000);
        // Observe native transition readiness without changing React's transition,
        // so data-ready, DOM commit and screenshot preparation remain distinguishable.
        const startViewTransition = document.startViewTransition;
        if (startViewTransition)
            document.startViewTransition = function (...args) {
                const entry = { start: performance.now() };
                if (transitionDetails) entry.caller = new Error().stack;
                audit.transitions.push(entry);
                const transition = startViewTransition.apply(this, args);
                for (const phase of ["updateCallbackDone", "ready", "finished"])
                    transition[phase].then(
                        () => {
                            entry[phase] = performance.now();
                            if (phase === "ready") {
                                entry.workspaceVisible =
                                    document.querySelector(".boot-workspace")?.style.visibility === "visible";
                                if (transitionDetails) {
                                    entry.rootName = getComputedStyle(
                                        document.documentElement
                                    ).viewTransitionName;
                                    entry.participants = Array.from(
                                        document.querySelectorAll('[style*="view-transition"]'),
                                        (element) => ({
                                            tag: element.tagName,
                                            className: element.getAttribute("class"),
                                            name: element.style.viewTransitionName,
                                            transitionClass: element.style.viewTransitionClass,
                                        })
                                    );
                                    entry.animations = document.documentElement
                                        .getAnimations({ subtree: true })
                                        .filter((animation) =>
                                            animation.effect?.pseudoElement?.startsWith("::view-transition")
                                        )
                                        .map((animation) => ({
                                            pseudo: animation.effect.pseudoElement,
                                            name: animation.animationName,
                                            playState: animation.playState,
                                            duration: animation.effect.getTiming().duration,
                                        }));
                                }
                            }
                        },
                        () => (entry[`${phase}Rejected`] = performance.now())
                    );
                return transition;
            };
        const checkpoint = (name) => {
            audit.checkpoints[name] ??= performance.now();
        };
        checkpoint("entry");
        const record = (data, direction) => {
            if (Array.isArray(data)) {
                for (const message of data) record(message, direction);
                return;
            }
            if (data && typeof data === "object") {
                if (data._tag === "Request")
                    audit.rpc.push({
                        direction,
                        at: performance.now(),
                        id: String(data.id),
                        tag: data.tag,
                        view: data.tag === "SubscribeState" ? data.payload?.view : undefined,
                    });
                else if (data._tag)
                    audit.messages.push({
                        direction,
                        at: performance.now(),
                        id: String(data.requestId ?? data.id ?? ""),
                        tag: data._tag,
                    });
            }
        };
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (...args) {
            record(args[0], "send");
            return post.apply(this, args);
        };
        const Shared = globalThis.SharedWorker;
        if (Shared)
            globalThis.SharedWorker = new Proxy(Shared, {
                construct(target, args) {
                    checkpoint("worker-created");
                    const worker = Reflect.construct(target, args);
                    worker.port.addEventListener("message", (event) => {
                        checkpoint("worker-first-message");
                        record(event.data, "receive");
                    });
                    return worker;
                },
            });
        const sample = () => {
            if (document.querySelector(".opening")) checkpoint("splash");
            if (document.querySelector(".notes-app")) checkpoint("workspace-mounted");
            const rows = document.querySelectorAll(".note-preview");
            if (rows.length) checkpoint("rows-mounted");
            if (document.querySelector(".boot-workspace")?.style.visibility === "visible") {
                checkpoint("workspace-visible");
                if (rows.length) {
                    checkpoint("rows-visible");
                    audit.visibleRows ??= rows.length;
                    if (audit.checkpoints["rows-paint-opportunity"] === undefined)
                        requestAnimationFrame(() => checkpoint("rows-paint-opportunity"));
                }
            }
            if (!globalThis.partyTraceProbe && !audit.traceCaptureFinished) {
                try {
                    globalThis.readBootTraces("start");
                    checkpoint("trace-store-observed");
                } catch {
                    // The provider has not committed its LiveOntology context yet.
                }
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    },
    process.env.PARTY_TRANSITION_DETAILS === "1" || process.env.PARTY_ASSERT_STARTUP_TRANSITIONS === "1"
);
const results = [];
try {
    if (populatedWorker) {
        // Ordinary download setup populates the worker's actual persisted cache.
        // Keep this tab alive so measured /trash boot gets a fresh memory replica
        // against that same running worker, with no fixture-row writes or seeding.
        const setup = await context.newPage();
        await setup.goto(new URL("/", base).href);
        await setup.getByRole("listbox", { name: "Notes", exact: true }).waitFor();
        await setFolderDownload(setup, true);
    }
    for (const pass of trashBoot
        ? [populatedWorker ? "fresh-tab-populated-worker" : "fresh-tab-cold-worker"]
        : ["fresh-context", "reload", "reload-again"]) {
        if (!results.length) await page.goto(trashBoot ? new URL("/trash", base).href : base);
        else await page.reload();
        await page.waitForFunction(
            (needsRows) =>
                needsRows
                    ? window.startupProfile.checkpoints["rows-paint-opportunity"] !== undefined
                    : document.querySelector(".boot-workspace")?.style.visibility === "visible",
            trashBoot,
            { timeout: 30_000 }
        );
        const report = await page.evaluate(() => ({
            ...window.startupProfile,
            timeOrigin: performance.timeOrigin,
            navigation: performance.getEntriesByType("navigation").map((n) => n.toJSON()),
            resources: performance.getEntriesByType("resource").map((r) => ({
                path: new URL(r.name).pathname,
                start: r.startTime,
                duration: r.duration,
                bytes: r.encodedBodySize,
                transfer: r.transferSize,
                type: r.initiatorType,
            })),
        }));
        report.rpc = report.rpc.map(({ view, ...request }) => {
            if (!view) return request;
            const decoded = Schema.decodeUnknownSync(ClientViewCodec)(view);
            return {
                ...request,
                generation: decoded.generation,
                types: decoded.selection.subsets.map((subset) => subset.objectType),
                selection: decoded.selection,
            };
        });
        const checkpoints = Object.fromEntries(
            Object.entries(report.checkpoints).map(([name, at]) => [name, Math.round(at)])
        );
        console.log(pass, checkpoints);
        console.log(
            "RPC requests:",
            report.rpc.map(({ at, tag, types }) => ({ at: Math.round(at), tag, types }))
        );
        console.log(
            "Last/slow resources:",
            report.resources
                .sort((a, b) => b.start + b.duration - a.start - a.duration)
                .slice(0, 12)
                .map((r) => ({ ...r, start: Math.round(r.start), duration: Math.round(r.duration) }))
        );
        // Recording observes the existing provider as soon as its context is
        // available; it creates no replica/query and seeds from its trace buffer.
        await page.waitForFunction(() => globalThis.partyTraceProbe.parent.size > 0);
        report.traces = await page.evaluate(() => {
            window.startupProfile.traceCaptureFinished = true;
            return globalThis.readBootTraces("stop");
        });
        const spans = report.traces.tab;
        const byId = new Map(spans.map((span) => [span.id, span]));
        const relative = (epoch) => (epoch === undefined ? undefined : epoch - report.timeOrigin);
        const first = (name) =>
            spans.filter((span) => span.name === name).sort((a, b) => a.startedAt - b.startedAt)[0];
        const acquisitions = Object.fromEntries(
            ["Preferences", "Notebook", "Note"].map((objectType) => {
                const subscription = spans
                    .filter(
                        (span) => span.name === "Replica.demand" && span.attributes?.objectType === objectType
                    )
                    .sort((a, b) => a.startedAt - b.startedAt)[0];
                // The attributed subscription is a child of public demand.acquire.
                // Its completed ancestor marks initial acquisition, not later refreshes.
                let acquire = subscription && byId.get(subscription.parentId);
                while (acquire && acquire.name !== "Replica.demand") acquire = byId.get(acquire.parentId);
                return [
                    objectType,
                    {
                        start: relative(acquire?.startedAt ?? subscription?.startedAt),
                        ready:
                            acquire?.outcome === "success"
                                ? relative(acquire.startedAt + acquire.durationMs)
                                : undefined,
                        subscriptionStart: relative(subscription?.startedAt),
                        acquireSpanId: acquire?.id,
                        subscriptionSpanId: subscription?.id,
                    },
                ];
            })
        );
        const latestInstall = spans
            .filter(
                (span) =>
                    span.name === "Delivery.install" &&
                    span.outcome === "success" &&
                    span.attributes?.end &&
                    span.attributes.changes > 0 &&
                    relative(span.startedAt + span.durationMs) <= report.checkpoints["rows-visible"]
            )
            .sort((a, b) => b.startedAt + b.durationMs - a.startedAt - a.durationMs)[0];
        const routeModules = report.resources.filter(
            (resource) =>
                resource.type === "script" &&
                /\/src\/(?:routes\/_workspace|notes\/(?:NotesProvider|NotesViews|NotesListQuery|TrashedNotes|NoteList))/.test(
                    resource.path
                )
        );
        const difference = (end, start) =>
            end === undefined || start === undefined ? undefined : end - start;
        const nativeOpen = first("OntologyHost.open");
        const view = first("Ontology.view");
        const latestRouteModuleFetchEnd = routeModules.length
            ? Math.max(...routeModules.map((resource) => resource.start + resource.duration))
            : undefined;
        report.bootPhase = {
            route: trashBoot ? "/trash" : new URL(base).pathname,
            workerState: populatedWorker
                ? "running-with-complete-offline-cache"
                : pass.startsWith("fresh-")
                  ? "fresh-context-empty-storage"
                  : "existing-context-after-previous-load",
            setupTabRetained: populatedWorker,
            // Resource completion proves fetching, not module evaluation. The
            // worker constructor is the first observed entry into native setup.
            routeModuleFetches: routeModules,
            latestRouteModuleFetchEnd,
            appEnteredNativeSetup: report.checkpoints["worker-created"],
            nativeHostOpen: relative(nativeOpen?.startedAt),
            nativeViewReady: view && relative(view.startedAt + view.durationMs),
            handshake: report.rpc
                .filter(
                    (request) => request.direction === "send" && /^(?:Describe|OpenClient)$/.test(request.tag)
                )
                .map((request) => ({
                    tag: request.tag,
                    sent: request.at,
                    replies: report.messages
                        .filter((message) => message.direction === "receive" && message.id === request.id)
                        .map(({ at, tag }) => ({ at, tag })),
                })),
            acquisitions,
            lastDataInstallBeforeRender:
                latestInstall && relative(latestInstall.startedAt + latestInstall.durationMs),
            visibleRows: report.visibleRows,
            durations: {
                nativeSetupToRowsPaintOpportunity: difference(
                    report.checkpoints["rows-paint-opportunity"],
                    report.checkpoints["worker-created"]
                ),
                nativeHostOpenToRowsPaintOpportunity: difference(
                    report.checkpoints["rows-paint-opportunity"],
                    relative(nativeOpen?.startedAt)
                ),
                noteDemandToRowsPaintOpportunity: difference(
                    report.checkpoints["rows-paint-opportunity"],
                    acquisitions.Note.start
                ),
                noteReadyToRowsPaintOpportunity: difference(
                    report.checkpoints["rows-paint-opportunity"],
                    acquisitions.Note.ready
                ),
                routeFetchEndToRowsPaintOpportunity: difference(
                    report.checkpoints["rows-paint-opportunity"],
                    latestRouteModuleFetchEnd
                ),
                preferencesReadyToNotebookDemand: difference(
                    acquisitions.Notebook.start,
                    acquisitions.Preferences.ready
                ),
                notebookReadyToNoteDemand: difference(acquisitions.Note.start, acquisitions.Notebook.ready),
            },
        };
        console.log("Boot phase:", JSON.stringify(report.bootPhase, null, 2));
        results.push({ pass, ...report });
    }
    await writeFile("/tmp/party-notes-startup-profile.json", JSON.stringify({ results, errors }, null, 2));
    console.log("Trace report: /tmp/party-notes-startup-profile.json");
    console.log("Errors:", errors);
    if (
        process.env.PARTY_ASSERT_STARTUP_TRANSITIONS === "1" &&
        results.some((result) =>
            result.transitions.some(
                (transition) =>
                    transition.workspaceVisible === false &&
                    transition.animations?.some(
                        (animation) => animation.playState === "running" && animation.duration > 0
                    )
            )
        )
    )
        throw new Error("A hidden workspace animation delayed the startup reveal.");
} finally {
    await browser.close();
}
