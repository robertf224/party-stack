"use client";

import { createCollection } from "@tanstack/db";
import { createFoundryOntologyBackend, createOntologyClient } from "@party-stack/foundry-ontology";
import { userCollectionOptions } from "@party-stack/foundry-ontology/users";
import { createWebRuntime } from "@party-stack/web-runtime";
import { createIssueTrackerLiveOntology } from "../ontology/generated/live";

const client = createOntologyClient({
    baseUrl: import.meta.env.NEXT_PUBLIC_FOUNDRY_URL,
    ontologyRid: import.meta.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID,
    tokenProvider: () => Promise.resolve(import.meta.env.NEXT_PUBLIC_FOUNDRY_TOKEN),
});
const backend = createFoundryOntologyBackend({
    client,
});
const ontologyId = import.meta.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID;
const userId = "77a1fe87-ad9f-4cd7-ba76-223ab048d2d3";
async function createCollections() {
    return {
        ontology: await createIssueTrackerLiveOntology({
            backend,
            id: ontologyId,
            runtime: createWebRuntime,
            persistObjects: true,
            writes: {
                defaultMode: "outbox",
                defaultVisibility: "optimistic",
            },
            context: {
                userId,
            },
            getUserId: (context) => context.userId,
        }),
        User: createCollection(userCollectionOptions({ client })),
    };
}

const collections = await createCollections();

export function getIssueTrackerCollections() {
    return collections;
}
