"use client";

import {
    createFoundryOntologyBackend,
    createOntologyClient,
} from "@party-stack/foundry-ontology";
import { createRemoteOntologyBackend } from "@party-stack/remote-ontology/client";
import { createHttpRemoteOntologyTransport } from "@party-stack/remote-ontology/http";
import { createWebRuntime } from "@party-stack/web-runtime";
import { createIssueTrackerLiveOntology } from "../ontology/generated/live";

export type BackendKind = "foundry" | "sqlite";

const client = createOntologyClient({
    baseUrl: import.meta.env.NEXT_PUBLIC_FOUNDRY_URL,
    ontologyRid: import.meta.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID,
    tokenProvider: () =>
        Promise.resolve(import.meta.env.NEXT_PUBLIC_FOUNDRY_TOKEN),
});

const backend = createFoundryOntologyBackend({ client });

const remoteBackend = createRemoteOntologyBackend({
    createTransport: (ir) =>
        createHttpRemoteOntologyTransport({
            url: "/api/remote-ontology/",
            ir,
        }),
});

const writes = {
    defaultMode: "outbox" as const,
    defaultVisibility: "optimistic" as const,
};

const [foundry, sqlite] = await Promise.all([
    createIssueTrackerLiveOntology({
        backend,
        id: import.meta.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID,
        runtime: createWebRuntime,
        persistObjects: true,
        writes,
    }),
    createIssueTrackerLiveOntology({
        backend: remoteBackend,
        id: "issue-tracker-remote-sqlite",
        runtime: createWebRuntime,
        persistObjects: false,
        writes,
    }),
]);

export function getIssueTrackerCollections() {
    return { foundry, sqlite };
}
