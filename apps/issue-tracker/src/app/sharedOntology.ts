import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { BackendError } from "@party-stack/ontology-backend";
import { connectInstallationWorker } from "@party-stack/ontology-server/installation/worker";
import * as WebRuntime from "@party-stack/web-runtime";
import { Effect, Exit, Scope } from "effect";
import { TRACKER_CACHE_EPOCH, trackerWrites } from "./trackerConfig";
import type { OntologyBackendInstallation } from "@party-stack/ontology";

/** Placement only: the library handles Connect, RPC routing, local replicas and subscriptions. */
export async function openSharedInstallation<A extends object>(
    installationId: string,
    oauth = false
): Promise<OntologyBackendInstallation<A>> {
    if (typeof SharedWorker === "undefined")
        throw new BackendError({
            operation: "installation.connect",
            kind: "NotImplemented",
            retryable: false,
            message: "This example requires SharedWorker support for persistent storage.",
        });
    const scope = Effect.runSync(Scope.make());
    try {
        const installation = await Effect.runPromise(
            Scope.provide(
                connectInstallationWorker<A>({
                    runtime: WebRuntime.layer({ storage: "memory" }),
                    writes: trackerWrites,
                    browserAuthentication: oauth ? WebRuntime.createWebBrowserAuthentication() : undefined,
                }).pipe(
                    Effect.provide(
                        BrowserWorker.layer(
                            () =>
                                new SharedWorker(new URL("./ontologyOwner.worker.ts", import.meta.url), {
                                    name: JSON.stringify({ cacheEpoch: TRACKER_CACHE_EPOCH, installationId }),
                                    type: "module",
                                })
                        )
                    )
                ),
                scope
            )
        );
        const cleanup = () => Effect.runPromise(Scope.close(scope, Exit.void));
        const hidden = () => {
            void cleanup();
        };
        window.addEventListener("pagehide", hidden, { once: true });
        return {
            ...installation,
            cleanup: async () => {
                window.removeEventListener("pagehide", hidden);
                await cleanup();
            },
        };
    } catch (cause) {
        await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
        throw cause;
    }
}
