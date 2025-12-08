import { OntologiesV2, OntologyFullMetadata } from "@osdk/foundry.ontologies";
import { createCollection } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { OntologyClient } from "../utils/client";

export interface CreateOntologyMetadataCollectionsOpts {
    client: OntologyClient;
}

export function createOntologyMetadataCollections({ client }: CreateOntologyMetadataCollectionsOpts) {
    const $ontology = createCollection(
        queryCollectionOptions<OntologyFullMetadata>({
            queryClient: new QueryClient(),
            getKey: (ontology) => ontology.ontology.rid,
            queryKey: ["foundry", "ontology-full-metadata"],
            syncMode: "on-demand",
            queryFn: async () => {
                const ontology = await OntologiesV2.getFullMetadata(client, client.ontologyRid);
                return [ontology];
            },
        })
    );

    /*const objectTypesCollection = createCollection(
        liveQueryCollectionOptions({
            query: (q) =>
                q
                    .from({ $ontology })
                    .where(({ $ontology }) => eq($ontology.ontology.rid, client.ontologyRid))
                    .fn.select(({ $ontology }) => Object.values($ontology.objectTypes)),
        })
    );*/
}
