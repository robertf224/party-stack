import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { createLiveOntology } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { createConnectedLiveOntology } from "@party-stack/ontology-server/client";
import { connectOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import * as WebRuntime from "@party-stack/web-runtime";
import { Effect } from "effect";
import type { CreateOntologyBackendInstallationOptions, LiveOntology } from "@party-stack/ontology";

type OpenOptions = Parameters<NonNullable<CreateOntologyBackendInstallationOptions["openOntology"]>>[0];

/** Domain/placement choices; replica, operations and tracing compose in the library. */
export async function openSharedOntology(options: OpenOptions): Promise<LiveOntology> {
    if (typeof SharedWorker === "undefined") return createLiveOntology(options);
    const partition = {
        installationId: options.installationId,
        userId: options.userId,
        ontologyId: options.ontologyId,
    };
    let live: LiveOntology;
    try {
        live = await createConnectedLiveOntology({
            id: options.id,
            ir: options.ir,
            context: options.context,
            writes: options.writes,
            connection: connectOntologyWorker({ connectionTimeoutMs: 20_000 }).pipe(
                Effect.provide(
                    BrowserWorker.layer(
                        () =>
                            new SharedWorker(new URL("./ontologyOwner.worker.ts", import.meta.url), {
                                name: JSON.stringify(partition),
                                type: "module",
                            })
                    )
                )
            ),
            runtime: WebRuntime.layer({
                owner: options.userId,
                namespace: `tab:${crypto.randomUUID()}`,
                storage: "memory",
            }),
            label: "This tab",
            parent: { label: "Host", location: "Shared worker" },
        });
    } catch (cause) {
        if (
            !(cause instanceof BackendError) ||
            cause.kind !== "Unavailable" ||
            !["worker.connect", "remote.protocol"].includes(cause.operation)
        )
            throw cause;
        // Startup fallback still acquires the same persistent namespace's Web Lock.
        console.warn("Shared ontology startup failed; using the in-process owner.", cause);
        return createLiveOntology(options);
    }
    // This example's view belongs to the page; a route-owned view can instead close on unmount.
    const restored = (event: PageTransitionEvent) => {
        if (event.persisted) window.location.reload();
    };
    const cleanup = (restore = false) => {
        window.removeEventListener("pagehide", hidden);
        if (!restore) window.removeEventListener("pageshow", restored);
        return live.cleanup();
    };
    const hidden = () => {
        void cleanup(true).catch(() => undefined);
    };
    window.addEventListener("pagehide", hidden, { once: true });
    window.addEventListener("pageshow", restored);
    return {
        ...live,
        cleanup: () => cleanup(),
        destroy: async () => {
            window.removeEventListener("pagehide", hidden);
            window.removeEventListener("pageshow", restored);
            await live.destroy();
        },
    };
}
