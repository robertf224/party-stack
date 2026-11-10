import { createLiveOntology, createOntologyClient } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { createAuthenticationClient } from "@party-stack/ontology/authentication";
import { workerClient } from "@party-stack/ontology/worker";
import { webRuntime } from "@party-stack/web-runtime";
import { TRACKER_CACHE_EPOCH, trackerWrites } from "./trackerConfig";
import type { IssueTrackerOntology } from "../ontology/generated/types";
import type { AccountRef } from "@party-stack/ontology/authentication";

/** Every target uses the same server and standard ontology protocol. Each tab owns only memory replicas. */
export const trackerClient = await createOntologyClient(
    workerClient(
        () => {
            if (typeof SharedWorker === "undefined")
                throw new BackendError({
                    operation: "tracker.connect",
                    kind: "NotImplemented",
                    retryable: false,
                    message: "This example requires SharedWorker support for persistent storage.",
                });
            return new SharedWorker(new URL("./ontologyOwner.worker.ts", import.meta.url), {
                // Load the updated owner even if a previous worker survives a dev
                // reload. This version affects the process, not its storage addresses.
                name: `issue-tracker:${TRACKER_CACHE_EPOCH}:connect-v3`,
                type: "module",
            });
        },
        { connectionTimeoutMs: 20_000 }
    )
);
export const trackerViewOptions = {
    traceRecording: "buffer" as const,
    runtime: webRuntime({ storage: "memory" }),
    writes: trackerWrites,
    parent: { label: "SharedWorker", location: "Shared worker" },
};
export const issueOntologyName = (account: AccountRef) => {
    const objectType = {
        oauth: "OAuthConnection",
        "api-key": "ApiKeyConnection",
        "external-session": "ExternalSessionConnection",
    }[account.kind];
    return `issues/${objectType}/${encodeURIComponent(account.id)}`;
};
export const authentication = await createAuthenticationClient({
    client: trackerClient,
    runtime: webRuntime({ storage: "memory" }),
});
export async function openIssueOntology(connection: AccountRef) {
    const view = await createLiveOntology<IssueTrackerOntology>({
        ...trackerViewOptions,
        client: trackerClient,
        ontology: issueOntologyName(connection),
    });
    const hidden = () => {
        void view.cleanup();
    };
    window.addEventListener("pagehide", hidden, { once: true });
    return {
        ...view,
        cleanup: async () => {
            window.removeEventListener("pagehide", hidden);
            await view.cleanup();
        },
    };
}
window.addEventListener(
    "pagehide",
    () => {
        void authentication.cleanup().then(() => trackerClient.cleanup());
    },
    { once: true }
);
