import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { OntologyCollectionOptions, QueryFunctionTypeDef } from "@party-stack/ontology";

/**
 * Salesforce has no native equivalent to Foundry query functions in this slice.
 * Return an empty on-demand collection so pull/meta LiveOntology still works.
 */
export function queryFunctionTypeCollectionOptions(): OntologyCollectionOptions {
    return queryCollectionOptions<QueryFunctionTypeDef>({
        queryClient: new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["salesforce", "ontology", "queryFunctionTypes"],
        syncMode: "on-demand",
        queryFn: () => Promise.resolve([]),
    }) as unknown as OntologyCollectionOptions;
}
