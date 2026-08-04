import {
    OntologiesV2,
    ObjectTypesV2,
} from "@osdk/foundry.ontologies";
import {
    createCollection,
    eq,
    FieldPath,
    liveQueryCollectionOptions,
    LoadSubsetOptions,
    parseWhereExpression,
    Query,
    queryOnce,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { OntologyClient } from "@party-stack/foundry-client";
import type {
    MetaLinkType,
    MetaObjectType,
    MetaValueType,
    OntologyCollectionOptions,
} from "@party-stack/ontology";
import { chunk } from "../utils/chunk.js";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import { convertFoundryMetaValueType } from "./convertMetaValueType.js";

type MetaEntity =
    | { entityType: "ObjectType"; entity: MetaObjectType }
    | { entityType: "ValueType"; entity: MetaValueType }
    | { entityType: "LinkType"; entity: MetaLinkType };

export interface MetaEntityStoreOpts {
    client: OntologyClient;
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
            queryKey: ["foundry", "ontology", "metadata"],
            syncMode: "on-demand",
            queryFn: async () => {
                const loaded = await loadFoundryMetaOntology(opts.client);
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

export function objectTypeCollectionOptions(
    metadata: MetaEntityCollection,
    opts: MetaEntityStoreOpts
): OntologyCollectionOptions {
    return queryCollectionOptions<MetaObjectType>({
        queryClient: new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["foundry", "ontology", "objectTypes"],
        syncMode: "on-demand",
        queryFn: async (ctx) => {
            const query = convertObjectTypeQuery(ctx.meta?.loadSubsetOptions);
            if (query.type === "byRid") {
                return loadObjectTypesByRid(opts.client, query.rids);
            }
            const rows = await queryOnce((q) =>
                q
                    .from({ metadata })
                    .where(({ metadata }) => eq(metadata.entityType, "ObjectType"))
            );
            return rows.flatMap((row) =>
                row.entityType === "ObjectType" ? [row.entity] : []
            );
        },
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

async function loadFoundryMetaOntology(client: OntologyClient): Promise<{
    objectTypes: MetaObjectType[];
    valueTypes: MetaValueType[];
    linkTypes: MetaLinkType[];
}> {
    const ontology = await OntologiesV2.getFullMetadata(client, client.ontologyRid);
    const objectTypeMetadata = Object.values(ontology.objectTypes);

    const objectTypes = objectTypeMetadata.map(convertFoundryMetaObjectType);
    const valueTypes = Object.values(ontology.valueTypes).map(convertFoundryMetaValueType);
    const linkTypes = convertFoundryMetaLinkTypes(objectTypeMetadata);

    return {
        objectTypes,
        valueTypes,
        linkTypes,
    };
}

type ObjectTypeQuery =
    | { type: "byRid"; rids: string[] }
    | { type: "fullMetadata" };

function convertObjectTypeQuery(options?: LoadSubsetOptions): ObjectTypeQuery {
    if (!options?.where) {
        return { type: "fullMetadata" };
    }

    const ridQuery =
        parseWhereExpression<ObjectTypeQuery | undefined>(options.where, {
            handlers: {
                and: (...queries: Array<ObjectTypeQuery | undefined>) => {
                    const rids = queries.flatMap((query) =>
                        query?.type === "byRid" ? query.rids : []
                    );
                    return rids.length > 0
                        ? { type: "byRid", rids: Array.from(new Set(rids)) }
                        : undefined;
                },
                or: (...queries: Array<ObjectTypeQuery | undefined>) => {
                    if (
                        queries.length === 0 ||
                        queries.some((query) => query?.type !== "byRid")
                    ) {
                        return undefined;
                    }
                    return {
                        type: "byRid",
                        rids: Array.from(
                            new Set(
                                queries.flatMap((query) =>
                                    query?.type === "byRid" ? query.rids : []
                                )
                            )
                        ),
                    };
                },
                eq: (field: FieldPath, value: unknown) => {
                    if (field.join(".") === "id" && typeof value === "string") {
                        return { type: "byRid", rids: [value] };
                    }
                },
                in: (field: FieldPath, values: unknown[]) => {
                    if (field.join(".") === "id") {
                        return {
                            type: "byRid",
                            rids: values.filter(
                                (value): value is string =>
                                    typeof value === "string" && value.length > 0
                            ),
                        };
                    }
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;

    return ridQuery?.type === "byRid"
        ? ridQuery
        : { type: "fullMetadata" };
}

async function loadObjectTypesByRid(
    client: OntologyClient,
    rids: string[]
): Promise<MetaObjectType[]> {
    const uniqueRids = Array.from(new Set(rids));
    if (uniqueRids.length === 0) {
        return [];
    }

    const responses = await Promise.all(
        chunk(uniqueRids, 100).map((batch) =>
            ObjectTypesV2.getByRidBatch(
                client,
                client.ontologyRid,
                {
                    requests: batch.map((objectTypeRid) => ({ objectTypeRid })),
                },
                { preview: true }
            )
        )
    );

    return responses
        .flatMap((response) => response.data)
        .map(convertFoundryMetaObjectType);
}
