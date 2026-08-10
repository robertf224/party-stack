import {
    createCollection,
    eq,
    liveQueryCollectionOptions,
    Query,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type {
    MetaLinkType,
    MetaObjectType,
    MetaValueType,
    OntologyCollectionOptions,
} from "@party-stack/ontology";
import type { SalesforceClient } from "@party-stack/salesforce-client";
import { convertSalesforceMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertSalesforceMetaObjectType } from "./convertMetaObjectType.js";

type MetaEntity =
    | { entityType: "ObjectType"; entity: MetaObjectType }
    | { entityType: "ValueType"; entity: MetaValueType }
    | { entityType: "LinkType"; entity: MetaLinkType };

export interface MetaEntityStoreOpts {
    client: SalesforceClient;
    /**
     * Optional allowlist of sObject API names. When omitted, all queryable
     * sObjects from the global describe are loaded.
     */
    objectTypeNames?: string[];
}

export function createMetaEntityCollection(opts: MetaEntityStoreOpts) {
    return createCollection(
        queryCollectionOptions<MetaEntity>({
            queryClient: new QueryClient(),
            getKey: (row) => {
                switch (row.entityType) {
                    case "ObjectType":
                    case "ValueType":
                        return `${row.entityType}:${row.entity.name}`;
                    case "LinkType":
                        return `${row.entityType}:${row.entity.id}`;
                }
            },
            queryKey: ["salesforce", "ontology", "metadata"],
            syncMode: "eager",
            queryFn: async () => {
                const loaded = await loadSalesforceMetaOntology(opts.client, opts.objectTypeNames);
                return [
                    ...loaded.objectTypes.map((entity) => ({
                        entityType: "ObjectType" as const,
                        entity,
                        ...entity,
                    })),
                    ...loaded.valueTypes.map((entity) => ({
                        entityType: "ValueType" as const,
                        entity,
                        ...entity,
                    })),
                    ...loaded.linkTypes.map((entity) => ({
                        entityType: "LinkType" as const,
                        entity,
                        ...entity,
                    })),
                ];
            },
        })
    );
}

export type MetaEntityCollection = ReturnType<typeof createMetaEntityCollection>;

export function objectTypeCollectionOptions(metadata: MetaEntityCollection): OntologyCollectionOptions {
    return liveQueryCollectionOptions({
        query: new Query()
            .from({ metadata })
            .where(({ metadata }) => eq(metadata.entityType, "ObjectType")),
    }) as unknown as OntologyCollectionOptions;
}

export function valueTypeCollectionOptions(metadata: MetaEntityCollection): OntologyCollectionOptions {
    return liveQueryCollectionOptions({
        query: new Query()
            .from({ metadata })
            .where(({ metadata }) => eq(metadata.entityType, "ValueType")),
    }) as unknown as OntologyCollectionOptions;
}

export function linkTypeCollectionOptions(metadata: MetaEntityCollection): OntologyCollectionOptions {
    return liveQueryCollectionOptions({
        query: new Query()
            .from({ metadata })
            .where(({ metadata }) => eq(metadata.entityType, "LinkType")),
    }) as unknown as OntologyCollectionOptions;
}

async function loadSalesforceMetaOntology(
    client: SalesforceClient,
    objectTypeNames?: string[]
): Promise<{
    objectTypes: MetaObjectType[];
    valueTypes: MetaValueType[];
    linkTypes: MetaLinkType[];
}> {
    const global = await client.describeGlobal();
    const allowlist = objectTypeNames ? new Set(objectTypeNames) : undefined;
    const candidates = global.sobjects.filter((sobject) => {
        if (!sobject.queryable) return false;
        if (allowlist && !allowlist.has(sobject.name)) return false;
        return true;
    });

    const describes = await Promise.all(
        candidates.map((sobject) => client.describeSObject(sobject.name))
    );

    return {
        objectTypes: describes.map(convertSalesforceMetaObjectType),
        valueTypes: [],
        linkTypes: convertSalesforceMetaLinkTypes(describes),
    };
}
