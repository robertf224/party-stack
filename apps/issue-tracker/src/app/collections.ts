"use client";

import { createCollection } from "@tanstack/db";
import { createOntologyClient, createFoundryOntologyAdapter } from "@party-stack/foundry-ontology";
import { userCollectionOptions } from "@party-stack/foundry-ontology/users";
import ir from "../ontology/ontology";
import { createIssueTrackerLiveOntology } from "../ontology/generated/live";

const client = createOntologyClient({
    baseUrl: process.env.NEXT_PUBLIC_FOUNDRY_URL!,
    ontologyRid: process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    tokenProvider: () => Promise.resolve(process.env.NEXT_PUBLIC_FOUNDRY_TOKEN!),
});
const adapter = createFoundryOntologyAdapter({ client, ir });
export const ontology = createIssueTrackerLiveOntology(adapter, {
    getContext: () => ({
        userId: "77a1fe87-ad9f-4cd7-ba76-223ab048d2d3",
    }),
});
export const User = createCollection(userCollectionOptions({ client }));
