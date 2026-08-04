import { OntologiesV2 } from "@osdk/foundry.ontologies";
import { normalizeFoundryError } from "@party-stack/foundry-client";
import {
    createCollection,
    eq,
    liveQueryCollectionOptions,
    Query,
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
            syncMode: "eager",
            queryFn: async () => {
                try {
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
                } catch (error) {
                    throw normalizeFoundryError(error);
                }
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

/**
 * Object/link/value meta entities are loaded from a single shared
 * `OntologiesV2.getFullMetadata` request (eager collection). Foundry has no narrower public API
 * that returns the property/title/link detail Party Stack needs, so RID/name filters are applied
 * by TanStack DB against this cached snapshot rather than a separate RID endpoint.
 */
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
