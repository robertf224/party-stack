"use client";

import { createOntologyClient, createFoundryOntologyAdapter } from "@party-stack/foundry-ontology";
import { createUserCollection } from "@party-stack/foundry-ontology/users";
import ontology from "../ontology/ontology";
import { createIssueTrackerLiveOntology } from "../ontology/generated/live";

const client = createOntologyClient({
    baseUrl: process.env.NEXT_PUBLIC_FOUNDRY_URL!,
    ontologyRid: process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    tokenProvider: () => Promise.resolve(process.env.NEXT_PUBLIC_FOUNDRY_TOKEN!),
});
const adapter = createFoundryOntologyAdapter({ client, ir: ontology });
const liveOntology = createIssueTrackerLiveOntology(adapter);
export const { Task } = liveOntology.objects;
export const User = createUserCollection({ client });
