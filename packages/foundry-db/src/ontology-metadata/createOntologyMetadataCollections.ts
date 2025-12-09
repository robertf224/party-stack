import {
    ActionTypeFullMetadata,
    ActionTypesFullMetadata,
    InterfaceType,
    ObjectTypeFullMetadata,
    OntologiesV2,
    OntologyValueType,
    QueryTypeV2,
    SharedPropertyType,
} from "@osdk/foundry.ontologies";
import { Collection, createCollection, eq, liveQueryCollectionOptions, Ref } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import { OntologyClient } from "../utils/client";

interface ObjectTypeEntry {
    type: "object-type";
    rid: string;
    objectType: ObjectTypeFullMetadata;
}

interface ValueTypeEntry {
    type: "value-type";
    rid: string;
    valueType: OntologyValueType;
}

interface QueryTypeEntry {
    type: "query-type";
    rid: string;
    queryType: QueryTypeV2;
}

interface InterfaceTypeEntry {
    type: "interface-type";
    rid: string;
    interfaceType: InterfaceType;
}

interface SharedPropertyTypeEntry {
    type: "shared-property-type";
    rid: string;
    sharedPropertyType: SharedPropertyType;
}

type OntologyMetadataCollectionEntry =
    | ObjectTypeEntry
    | ValueTypeEntry
    | QueryTypeEntry
    | InterfaceTypeEntry
    | SharedPropertyTypeEntry;

export interface CreateOntologyMetadataCollectionsOpts {
    client: OntologyClient;
}

export function createOntologyMetadataCollections({ client }: CreateOntologyMetadataCollectionsOpts): {
    $ontology: Collection<OntologyMetadataCollectionEntry>;
    $actionTypes: Collection<ActionTypeFullMetadata>;
    $objectTypes: Collection<ObjectTypeFullMetadata>;
    $valueTypes: Collection<OntologyValueType>;
    $queryTypes: Collection<QueryTypeV2>;
    $interfaceTypes: Collection<InterfaceType>;
    $sharedPropertyTypes: Collection<SharedPropertyType>;
} {
    const $ontology = createCollection(
        queryCollectionOptions<OntologyMetadataCollectionEntry>({
            queryClient: new QueryClient(),
            getKey: (entry) => entry.rid,
            queryKey: ["foundry", "ontology-metadata"],
            syncMode: "eager",
            queryFn: async () => {
                const ontology = await OntologiesV2.getFullMetadata(client, client.ontologyRid);
                return [
                    ...Object.values(ontology.objectTypes).map(
                        (objectType): ObjectTypeEntry => ({
                            type: "object-type",
                            rid: objectType.objectType.rid,
                            objectType,
                        })
                    ),
                    ...Object.values(ontology.valueTypes).map(
                        (valueType): ValueTypeEntry => ({
                            type: "value-type",
                            rid: valueType.rid,
                            valueType,
                        })
                    ),
                    ...Object.values(ontology.queryTypes).map(
                        (queryType): QueryTypeEntry => ({
                            type: "query-type",
                            rid: queryType.rid,
                            queryType,
                        })
                    ),
                    ...Object.values(ontology.interfaceTypes).map(
                        (interfaceType): InterfaceTypeEntry => ({
                            type: "interface-type",
                            rid: interfaceType.rid,
                            interfaceType,
                        })
                    ),
                    ...Object.values(ontology.sharedPropertyTypes).map(
                        (sharedPropertyType): SharedPropertyTypeEntry => ({
                            type: "shared-property-type",
                            rid: sharedPropertyType.rid,
                            sharedPropertyType,
                        })
                    ),
                ];
            },
        })
    );

    const $actionTypes = createCollection(
        queryCollectionOptions<ActionTypeFullMetadata>({
            queryClient: new QueryClient(),
            getKey: (actionType) => actionType.actionType.rid,
            queryKey: ["foundry", "action-types"],
            syncMode: "eager",
            queryFn: async () => {
                const actionTypes = AsyncIterable.toArray(
                    AsyncIterable.fromPagination(
                        (pageSize, pageToken: string | undefined) =>
                            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                            ActionTypesFullMetadata.list(client, client.ontologyRid, {
                                pageToken,
                                pageSize,
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                ...({ preview: true } as any),
                            }),
                        (page) => page.nextPageToken,
                        (page) => page.data,
                        500
                    )
                );
                return actionTypes;
            },
        })
    );

    const $objectTypes = createCollection(
        liveQueryCollectionOptions({
            query: (q) =>
                q
                    .from({ $ontology })
                    .where(({ $ontology }) => eq($ontology.type, "object-type"))
                    .select(({ $ontology }) => ({ ...($ontology as Ref<ObjectTypeEntry>).objectType })),
        })
    );

    const $valueTypes = createCollection(
        liveQueryCollectionOptions({
            query: (q) =>
                q
                    .from({ $ontology })
                    .where(({ $ontology }) => eq($ontology.type, "value-type"))
                    .select(({ $ontology }) => ({ ...($ontology as Ref<ValueTypeEntry>).valueType })),
        })
    );

    const $queryTypes = createCollection(
        liveQueryCollectionOptions({
            query: (q) =>
                q
                    .from({ $ontology })
                    .where(({ $ontology }) => eq($ontology.type, "query-type"))
                    .select(({ $ontology }) => ({ ...($ontology as Ref<QueryTypeEntry>).queryType })),
        })
    );

    const $interfaceTypes = createCollection(
        liveQueryCollectionOptions({
            query: (q) =>
                q
                    .from({ $ontology })
                    .where(({ $ontology }) => eq($ontology.type, "interface-type"))
                    .select(({ $ontology }) => ({ ...($ontology as Ref<InterfaceTypeEntry>).interfaceType })),
        })
    );

    const $sharedPropertyTypes = createCollection(
        liveQueryCollectionOptions({
            query: (q) =>
                q
                    .from({ $ontology })
                    .where(({ $ontology }) => eq($ontology.type, "shared-property-type"))
                    .select(({ $ontology }) => ({
                        ...($ontology as Ref<SharedPropertyTypeEntry>).sharedPropertyType,
                    })),
        })
    );

    return {
        $ontology,
        $actionTypes,
        $objectTypes,
        $valueTypes,
        $queryTypes,
        $interfaceTypes,
        $sharedPropertyTypes,
    };
}
