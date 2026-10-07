import {
    ActionTypesFullMetadata,
    ActionTypesV2,
    type ActionTypeFullMetadata,
    type ActionTypeV2,
} from "@osdk/foundry.ontologies";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { MetaActionType, OntologyCollectionOptions } from "@party-stack/ontology";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import {
    convertActionTypeLoadSubsetFilter,
    convertActionTypeLoadSubsetOrderBy,
} from "./convertActionTypeLoadSubsetOptions.js";
import { convertFoundryMetaActionType } from "./convertMetaActionType.js";
import { loadActionTypeOmsMetadata } from "./loadActionTypeOmsMetadata.js";
import type { LoadSubsetOptions } from "@tanstack/db";

export interface ActionTypeCollectionOpts {
    client: OntologyClient;
    refetchInterval?: number | false;
    queryClient?: QueryClient;
}

// These 404 for some reason on full metadata calls right now but we don't need them right now.
export function isNotDeclarativeActionType(actionType: ActionTypeV2): boolean {
    return actionType.operations.length === 0;
}

async function searchActionTypes(
    client: OntologyClient,
    options?: LoadSubsetOptions
): Promise<ActionTypeV2[]> {
    const where = convertActionTypeLoadSubsetFilter(options?.where);
    const orderBy = convertActionTypeLoadSubsetOrderBy(options?.orderBy);
    const canPushDownPagination = !options?.orderBy || orderBy !== undefined;
    const offset = canPushDownPagination ? (options?.offset ?? 0) : 0;
    const limit = canPushDownPagination ? options?.limit : undefined;

    const results = await AsyncIterable.toArray(
        AsyncIterable.fromPagination(
            (pageSize, pageToken: string | undefined) =>
                ActionTypesV2.search(
                    client,
                    client.ontologyRid,
                    {
                        where,
                        orderBy,
                        pageSize,
                        pageToken,
                        fuzziness: { type: "off" },
                    },
                    { preview: true }
                ),
            (page) => page.nextPageToken,
            (page) => page.data,
            100,
            limit === undefined ? undefined : offset + limit
        )
    );

    return results.slice(offset, limit === undefined ? undefined : offset + limit);
}

async function loadActionTypesFullMetadata(
    client: OntologyClient,
    actionTypes: ActionTypeV2[]
): Promise<ActionTypeFullMetadata[]> {
    const declarativeActionTypes = actionTypes.filter(
        (actionType) => !isNotDeclarativeActionType(actionType)
    );
    const fullMetadataByApiName = new Map<string, ActionTypeFullMetadata>();
    const fullMetadata = await AsyncIterable.toArray(
        AsyncIterable.fromBatches(
            declarativeActionTypes,
            async (batch) =>
                (
                    await ActionTypesFullMetadata.getFullMetadataBatch(
                        client,
                        client.ontologyRid,
                        {
                            requests: batch.map((actionType) => ({
                                actionType: actionType.apiName,
                            })),
                        },
                        { preview: true }
                    )
                ).data,
            100
        )
    );
    for (const metadata of fullMetadata) {
        fullMetadataByApiName.set(metadata.actionType.apiName, metadata);
    }

    return actionTypes.map(
        (actionType) =>
            fullMetadataByApiName.get(actionType.apiName) ?? {
                actionType,
                fullLogicRules: [],
            }
    );
}

export function actionTypeCollectionOptions(opts: ActionTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<MetaActionType>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["foundry", "ontology", "actionTypes"],
        syncMode: "on-demand",
        refetchInterval: opts.refetchInterval,
        queryFn: async (ctx) => {
            const actionTypes = await searchActionTypes(opts.client, ctx.meta?.loadSubsetOptions);
            const actionTypeMetadata = await loadActionTypesFullMetadata(opts.client, actionTypes);
            const omsMetadata = await loadActionTypeOmsMetadata(
                opts.client,
                actionTypeMetadata.map((metadata) => metadata.actionType.rid)
            );
            return actionTypeMetadata.map((metadata) =>
                convertFoundryMetaActionType(metadata, omsMetadata.get(metadata.actionType.rid))
            );
        },
    }) as unknown as OntologyCollectionOptions;
}
