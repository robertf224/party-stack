import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { salesforceObjectTypeId } from "../utils/ids.js";
import { convertSalesforceMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertMetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import { convertSalesforceMetaObjectType } from "./convertMetaObjectType.js";
import type { MetaObjectType, OntologyCollectionOptions } from "@party-stack/ontology";
import type { SalesforceClient, SalesforceSObjectDescribe } from "@party-stack/salesforce-client";

export interface MetaEntityStoreOpts {
    client: SalesforceClient;
    /**
     * Optional allowlist of sObject API names. When omitted, all queryable
     * sObjects from the global describe are loaded.
     */
    objectTypeNames?: string[];
}

export async function describeSObjects(
    client: SalesforceClient,
    names: readonly string[]
): Promise<SalesforceSObjectDescribe[]> {
    const describes = await Promise.all(
        [...new Set(names)].map(async (name) => {
            try {
                return await client.describeSObject(name);
            } catch {
                return undefined;
            }
        })
    );
    return describes.filter((describe): describe is SalesforceSObjectDescribe => Boolean(describe));
}

export function objectTypeCollectionOptions(opts: MetaEntityStoreOpts): OntologyCollectionOptions {
    return queryCollectionOptions<MetaObjectType>({
        queryClient: new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["salesforce", "ontology", "objectTypes", opts.objectTypeNames ?? "all"],
        syncMode: "on-demand",
        queryFn: async (ctx) => {
            const query = convertMetaNameQuery(ctx.meta?.loadSubsetOptions);
            if (query.type === "getBatch") {
                const allowlist = opts.objectTypeNames ? new Set(opts.objectTypeNames) : undefined;
                const names = allowlist ? query.names.filter((name) => allowlist.has(name)) : query.names;
                return (await describeSObjects(opts.client, names)).map(convertSalesforceMetaObjectType);
            }
            const global = await opts.client.describeGlobal();
            const allowlist = opts.objectTypeNames ? new Set(opts.objectTypeNames) : undefined;
            return global.sobjects
                .filter((sObject) => sObject.queryable && (!allowlist || allowlist.has(sObject.name)))
                .map((sObject): MetaObjectType => ({
                    id: salesforceObjectTypeId(sObject.name),
                    name: sObject.name,
                    displayName: sObject.label,
                    pluralDisplayName: sObject.labelPlural,
                    primaryKey: "Id",
                    properties: [],
                }));
        },
    }) as unknown as OntologyCollectionOptions;
}

export function valueTypeCollectionOptions(): OntologyCollectionOptions {
    return queryCollectionOptions({
        queryClient: new QueryClient(),
        getKey: (row: { name: string }) => row.name,
        queryKey: ["salesforce", "ontology", "valueTypes"],
        syncMode: "on-demand",
        queryFn: () => Promise.resolve([]),
    }) as unknown as OntologyCollectionOptions;
}

export function linkTypeCollectionOptions(opts: MetaEntityStoreOpts): OntologyCollectionOptions {
    return queryCollectionOptions({
        queryClient: new QueryClient(),
        getKey: (row: { id: string }) => row.id,
        queryKey: ["salesforce", "ontology", "linkTypes", opts.objectTypeNames ?? []],
        syncMode: "on-demand",
        queryFn: async () => {
            if (!opts.objectTypeNames?.length) return [];
            return convertSalesforceMetaLinkTypes(await describeSObjects(opts.client, opts.objectTypeNames));
        },
    }) as unknown as OntologyCollectionOptions;
}
