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
import type { LoadSubsetOptions } from "@tanstack/db";

export interface ActionTypeCollectionOpts {
    client: OntologyClient;
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

async function loadActionTypeFullMetadata(
    client: OntologyClient,
    actionType: ActionTypeV2
): Promise<ActionTypeFullMetadata> {
    if (isNotDeclarativeActionType(actionType)) {
        return {
            actionType,
            fullLogicRules: [],
        };
    }

    return ActionTypesFullMetadata.get(client, client.ontologyRid, actionType.apiName, { preview: true });
}

export function actionTypeCollectionOptions(opts: ActionTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<MetaActionType>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["foundry", "ontology", "actionTypes"],
        syncMode: "on-demand",
        queryFn: async (ctx) => {
            const actionTypes = await searchActionTypes(opts.client, ctx.meta?.loadSubsetOptions);
            const actionTypeMetadata = await Promise.all(
                actionTypes.map((actionType) => loadActionTypeFullMetadata(opts.client, actionType))
            );
            return actionTypeMetadata.map(convertFoundryMetaActionType);
        },
    }) as unknown as OntologyCollectionOptions;
}
