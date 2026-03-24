import { notImplemented } from "@bobbyfidz/panic";
import { ActionTypesFullMetadata, OntologiesV2 } from "@osdk/foundry.ontologies";
import {
    createCollection,
    eq,
    FieldPath,
    liveQueryCollectionOptions,
    LoadSubsetOptions,
    parseWhereExpression,
    Query,
} from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type {
    MetaActionType,
    MetaLinkType,
    MetaObjectType,
    MetaValueType,
    OntologyAdapter,
    OntologyCollectionOptions,
} from "@party-stack/ontology";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { convertFoundryMetaActionType } from "./convertMetaActionType.js";
import { convertFoundryMetaLinkTypes } from "./convertMetaLinkType.js";
import { convertFoundryMetaObjectType } from "./convertMetaObjectType.js";
import { convertFoundryMetaValueType } from "./convertMetaValueType.js";
import type { OntologyClient } from "../utils/client.js";

export interface CreateFoundryMetaOntologyAdapterOpts {
    client: OntologyClient;
}

type MetaEntity =
    | { entityType: "ObjectType"; entity: MetaObjectType }
    | { entityType: "ValueType"; entity: MetaValueType }
    | { entityType: "LinkType"; entity: MetaLinkType };

const foundryPreviewOptions = {
    preview: true,
} as unknown as Parameters<typeof ActionTypesFullMetadata.get>[3];

export function createFoundryMetaOntologyAdapter(
    opts: CreateFoundryMetaOntologyAdapterOpts
): OntologyAdapter {
    const queryClient = new QueryClient();
    const metadata = createCollection(
        queryCollectionOptions<MetaEntity>({
            queryClient,
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

    function createEntityCollectionOptions(entityType: MetaEntity["entityType"]): OntologyCollectionOptions {
        return liveQueryCollectionOptions({
            query: new Query()
                .from({ metadata })
                .where(({ metadata }) => eq(metadata.entityType, entityType)),
        }) as unknown as OntologyCollectionOptions;
    }

    function createActionTypeCollectionOptions(): OntologyCollectionOptions {
        return queryCollectionOptions<MetaActionType>({
            queryClient,
            getKey: (row) => row.name,
            queryKey: ["foundry", "ontology", "actionTypes"],
            syncMode: "on-demand",
            queryFn: async (ctx) => {
                const query = convertActionTypeQuery(ctx.meta?.loadSubsetOptions);
                if (query.names.length === 0) {
                    return [];
                }

                const actionTypeMetadata = await Promise.all(
                    query.names.map((name) =>
                        ActionTypesFullMetadata.get(
                            opts.client,
                            opts.client.ontologyRid,
                            toFoundryActionTypeName(name),
                            foundryPreviewOptions
                        )
                    )
                );
                return actionTypeMetadata.map(convertFoundryMetaActionType);
            },
        }) as unknown as OntologyCollectionOptions;
    }

    return {
        name: "foundry-metadata",
        getCollectionOptions: (objectType: string) => {
            switch (objectType) {
                case "ObjectType":
                    return createEntityCollectionOptions("ObjectType");
                case "ValueType":
                    return createEntityCollectionOptions("ValueType");
                case "LinkType":
                    return createEntityCollectionOptions("LinkType");
                case "ActionType":
                    return createActionTypeCollectionOptions();
                default:
                    throw new Error(`Unsupported Foundry metadata object type "${objectType}".`);
            }
        },
        applyAction: () => {
            notImplemented();
        },
        cleanup: async () => {
            await metadata.cleanup();
        },
    };
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

type ActionTypeQuery = { type: "byName"; names: string[] };

function convertActionTypeQuery(options?: LoadSubsetOptions): ActionTypeQuery {
    if (!options?.where) {
        throw new Error(
            'Foundry ActionType metadata currently only supports loadSubset queries filtered by "name".'
        );
    }

    const batchQuery =
        parseWhereExpression<ActionTypeQuery | undefined>(options.where, {
            handlers: {
                eq: (field: FieldPath, value: unknown) => {
                    if (field.join(".") === "name") {
                        return { type: "byName", names: [String(value)] };
                    }
                },
                in: (field: FieldPath, value: unknown[]) => {
                    if (field.join(".") === "name") {
                        return {
                            type: "byName",
                            names: value
                                .filter((candidate) => candidate !== null && candidate !== undefined)
                                .map(String),
                        };
                    }
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;

    if (!batchQuery) {
        throw new Error(
            'Foundry ActionType metadata currently only supports loadSubset queries filtered by "name".'
        );
    }

    return batchQuery;
}
