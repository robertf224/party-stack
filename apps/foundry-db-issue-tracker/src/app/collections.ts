"use client";

import { createOntologyClient } from "@bobbyfidz/foundry-db";
import { objectsCollectionOptions } from "@bobbyfidz/foundry-db/objects";
import { createOntologyMetadataCollections } from "@bobbyfidz/foundry-db/ontology-metadata";
import { createUsersCollection } from "@bobbyfidz/foundry-db/users";
import { StreamlineForm } from "@/__generated__/foundry-db/StreamlineForm";
import { StreamlineFormRevision } from "@/__generated__/foundry-db/StreamlineFormRevision";
import { createCollection } from "@tanstack/react-db";

const client = createOntologyClient({
    baseUrl: process.env.NEXT_PUBLIC_FOUNDRY_URL!,
    ontologyRid: process.env.NEXT_PUBLIC_FOUNDRY_ONTOLOGY_RID!,
    tokenProvider: () => Promise.resolve(process.env.NEXT_PUBLIC_FOUNDRY_TOKEN!),
});
export const $user = createUsersCollection({ client });
export const $form = createCollection(
    objectsCollectionOptions({
        client,
        objectType: "StreamlineForm",
        schema: StreamlineForm,
    })
);
export const $formRevision = createCollection(
    objectsCollectionOptions({
        client,
        objectType: "StreamlineFormRevision",
        schema: StreamlineFormRevision,
    })
);
export const { $actionTypes } = createOntologyMetadataCollections({ client });
