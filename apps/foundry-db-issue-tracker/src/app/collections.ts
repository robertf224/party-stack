"use client";

import { createOntologyClient } from "@bobbyfidz/foundry-db";
import { createFoundryOntologyAdapter } from "@bobbyfidz/foundry-db/objects";
import { createUserCollection } from "@bobbyfidz/foundry-db/users";
import ontology from "../ontology/ontology";
import { createFoundryDbIssueTrackerLiveOntology } from "../ontology/generated/live";

const client = createOntologyClient({
    baseUrl: process.env.NEXT_PUBLIC_FOUNDRY_URL!,
    ontologyRid: process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    tokenProvider: () => Promise.resolve(process.env.NEXT_PUBLIC_FOUNDRY_TOKEN!),
});
const adapter = createFoundryOntologyAdapter({ client, ir: ontology });
const liveOntology = createFoundryDbIssueTrackerLiveOntology(adapter);
const { StreamlineForm, StreamlineFormRevision } = liveOntology.objects;

export const $user = createUserCollection({ client });
export const $form = StreamlineForm;
export const $formRevision = StreamlineFormRevision;
