import {
    ActionTypesFullMetadata,
    ActionTypesV2,
    type ActionTypeFullMetadata,
    type ActionTypeV2,
} from "@osdk/foundry.ontologies";
import { normalizeFoundryError, type OntologyClient } from "@party-stack/foundry-client";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { MetaActionType, OntologyCollectionOptions } from "@party-stack/ontology";
import * as AsyncIterable from "../utils/AsyncIterable.js";
import {
    convertActionTypeLoadSubsetFilter,
    convertActionTypeLoadSubsetOrderBy,
} from "./convertActionTypeLoadSubsetOptions.js";
import { convertActionTypeRidQuery } from "./convertActionTypeRidQuery.js";
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

async function getActionTypesByRid(client: OntologyClient, rids: string[]): Promise<ActionTypeV2[]> {
    const uniqueRids = Array.from(new Set(rids));
    if (uniqueRids.length === 0) {
        return [];
    }

    const results = await Promise.all(
        uniqueRids.map(async (rid) => {
            try {
                return await ActionTypesV2.getByRid(client, client.ontologyRid, rid);
            } catch (error) {
                const normalized = normalizeFoundryError(error);
                if (normalized.statusCode === 404 || normalized.errorCode === "NOT_FOUND") {
                    return undefined;
                }
                throw normalized;
            }
        })
    );

    return results.filter((actionType): actionType is ActionTypeV2 => actionType !== undefined);
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

    let results: ActionTypeV2[];
    try {
        results = await AsyncIterable.toArray(
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
    } catch (error) {
        throw normalizeFoundryError(error);
    }

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

    try {
        return await ActionTypesFullMetadata.get(client, client.ontologyRid, actionType.apiName, {
            preview: true,
        });
    } catch (error) {
        throw normalizeFoundryError(error);
    }
}

/**
 * Loads ActionType meta rows for a TanStack load-subset query.
 *
 * Exact `id` (RID) filters are resolved with `ActionTypesV2.getByRid`, then each resolved API
 * name is hydrated with `ActionTypesFullMetadata.get`. Name/displayName filters continue to use
 * the search endpoint pushdown.
 */
export async function loadActionTypeCollectionRows(
    client: OntologyClient,
    loadSubsetOptions?: LoadSubsetOptions
): Promise<MetaActionType[]> {
    const ridQuery = convertActionTypeRidQuery(loadSubsetOptions);
    const actionTypes =
        ridQuery.type === "byRid"
            ? await getActionTypesByRid(client, ridQuery.rids)
            : await searchActionTypes(client, loadSubsetOptions);
    const actionTypeMetadata = await Promise.all(
        actionTypes.map((actionType) => loadActionTypeFullMetadata(client, actionType))
    );
    return actionTypeMetadata.map(convertFoundryMetaActionType);
}

export function actionTypeCollectionOptions(opts: ActionTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<MetaActionType>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row) => row.name,
        queryKey: ["foundry", "ontology", "actionTypes"],
        syncMode: "on-demand",
        queryFn: async (ctx) => loadActionTypeCollectionRows(opts.client, ctx.meta?.loadSubsetOptions),
    }) as unknown as OntologyCollectionOptions;
}
