import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { MetaActionType, OntologyCollectionOptions } from "@party-stack/ontology";
import type {
    SalesforceClient,
    SalesforceInvocableActionDescribe,
    SalesforceInvocableActionListResponse,
    SalesforceInvocableActionSummary,
} from "@party-stack/salesforce-client";
import { convertSalesforceMetaActionType } from "./convertMetaActionType.js";

export interface ActionTypeCollectionOpts {
    client: SalesforceClient;
    actionTypeNames?: string[];
    queryClient?: QueryClient;
}

function normalizeFlowActionList(
    response: SalesforceInvocableActionListResponse
): SalesforceInvocableActionSummary[] {
    if (Array.isArray(response)) {
        return response;
    }
    if (typeof response === "object" && response !== null && "actions" in response) {
        return Array.isArray(response.actions) ? response.actions : [];
    }
    // Some Salesforce responses return a map of actionName -> url.
    return Object.keys(response).map((name) => ({ name }));
}

async function listFlowActionNames(client: SalesforceClient): Promise<string[]> {
    const response = await client.listFlowActions();
    return normalizeFlowActionList(response).map((action) => action.name);
}

async function loadFlowActionDescribe(
    client: SalesforceClient,
    apiName: string
): Promise<SalesforceInvocableActionDescribe | undefined> {
    try {
        return await client.describeFlowAction(apiName);
    } catch {
        // Skip inaccessible or non-autolaunched flows.
        return undefined;
    }
}

export function actionTypeCollectionOptions(opts: ActionTypeCollectionOpts): OntologyCollectionOptions {
    return queryCollectionOptions<MetaActionType>({
        queryClient: opts.queryClient ?? new QueryClient(),
        getKey: (row) => row.name,
        queryKey: [
            "salesforce",
            "ontology",
            "actionTypes",
            opts.actionTypeNames ?? "all",
        ],
        syncMode: "on-demand",
        queryFn: async () => {
            const names =
                opts.actionTypeNames ??
                (await listFlowActionNames(opts.client));
            if (names.length === 0) {
                return [];
            }
            const describes = await Promise.all(
                names.map((name) => loadFlowActionDescribe(opts.client, name))
            );
            return describes
                .filter((describe): describe is SalesforceInvocableActionDescribe => Boolean(describe))
                .map(convertSalesforceMetaActionType);
        },
    }) as unknown as OntologyCollectionOptions;
}
