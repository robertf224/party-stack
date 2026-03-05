"use client";

import { createOntologyClient } from "@bobbyfidz/foundry-db";
import { createObjectCollection } from "@bobbyfidz/foundry-db/objects";
import { createOntologyMetadataCollections } from "@bobbyfidz/foundry-db/ontology-metadata";
import { createUserCollection } from "@bobbyfidz/foundry-db/users";

const client = createOntologyClient({
    baseUrl: process.env.NEXT_PUBLIC_FOUNDRY_URL!,
    ontologyRid: process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    tokenProvider: () => Promise.resolve(process.env.NEXT_PUBLIC_FOUNDRY_TOKEN!),
});
export const $user = createUserCollection({ client });
export const $form = createObjectCollection({
    client,
    objectType: "StreamlineForm",
});
export const $formRevision = createObjectCollection({
    client,
    objectType: "StreamlineFormRevision",
});
export const { $actionType: $actionTypes } = createOntologyMetadataCollections({ client });
