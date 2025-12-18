import { OntologiesV2, OntologyV2 } from "@osdk/foundry.ontologies";
import { createCollection } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { Client } from "../utils/client";

export interface CreateOntologiesCollectionOpts {
    client: Client;
}

export function createOntologiesCollection({ client }: CreateOntologiesCollectionOpts) {
    return createCollection(
        queryCollectionOptions<OntologyV2>({
            queryClient: new QueryClient(),
            getKey: (ontology) => ontology.rid,
            queryKey: ["foundry", "ontologies"],
            syncMode: "eager",
            queryFn: async () => {
                const ontologies = await OntologiesV2.list(client);
                return ontologies.data;
            },
        })
    );
}
