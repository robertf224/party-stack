import { classifySalesforceStandardAction } from "../standardActions.js";
import { salesforceCrudActionTypeId, salesforceCrudActionTypeName } from "../utils/ids.js";
import {
    convertSalesforceMetaActionType,
    convertSalesforceMetaStandardActionType,
} from "./convertMetaActionType.js";
import { matchesMetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import { synthesizeSalesforceCrudActionTypes } from "./synthesizeCrudActionTypes.js";
import type { SalesforceCrudActionTypeSelection } from "../crud.js";
import type { MetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import type { MetaActionType } from "@party-stack/ontology";
import type { Query } from "@party-stack/ontology-storage";
import type {
    SalesforceClient,
    SalesforceInvocableActionDescribe,
    SalesforceInvocableActionListResponse,
    SalesforceInvocableActionSummary,
    SalesforceSObjectDescribe,
} from "@party-stack/salesforce-client";

export interface ActionTypeLoadOptions {
    client: SalesforceClient;
    flowActionTypeNames?: string[];
    standardActionTypeNames?: string[];
    crudActionTypes?: readonly SalesforceCrudActionTypeSelection[];
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

async function loadStandardActionDescribe(
    client: SalesforceClient,
    apiName: string
): Promise<SalesforceInvocableActionDescribe | undefined> {
    try {
        return await client.describeStandardAction(apiName);
    } catch {
        // Skip standard actions unavailable to this user.
        return undefined;
    }
}

async function loadFlowActionDescribes(
    client: SalesforceClient,
    names: readonly string[]
): Promise<Array<SalesforceInvocableActionDescribe | undefined>> {
    if (typeof client.describeFlowActions === "function") {
        try {
            return await client.describeFlowActions(names);
        } catch {
            // Older Salesforce orgs may not expose Composite API access.
        }
    }
    return Promise.all(names.map((name) => loadFlowActionDescribe(client, name)));
}

async function loadStandardActionDescribes(
    client: SalesforceClient,
    names: readonly string[]
): Promise<Array<SalesforceInvocableActionDescribe | undefined>> {
    if (typeof client.describeStandardActions === "function") {
        try {
            return await client.describeStandardActions(names);
        } catch {
            // Older Salesforce orgs may not expose Composite API access.
        }
    }
    return Promise.all(names.map((name) => loadStandardActionDescribe(client, name)));
}

async function loadSelectedActionDescribes(
    client: SalesforceClient,
    flowNames: readonly string[],
    standardNames: readonly string[]
): Promise<
    [
        Array<SalesforceInvocableActionDescribe | undefined>,
        Array<SalesforceInvocableActionDescribe | undefined>,
    ]
> {
    if (typeof client.describeInvocableActions === "function") {
        try {
            const combined = await client.describeInvocableActions([
                ...flowNames.map((apiName) => ({
                    kind: "flow" as const,
                    apiName,
                })),
                ...standardNames.map((apiName) => ({
                    kind: "standard" as const,
                    apiName,
                })),
            ]);
            return [combined.slice(0, flowNames.length), combined.slice(flowNames.length)];
        } catch {
            // Fall through to subsystem-specific compatibility methods.
        }
    }
    return Promise.all([
        flowNames.length > 0 ? loadFlowActionDescribes(client, flowNames) : [],
        standardNames.length > 0 ? loadStandardActionDescribes(client, standardNames) : [],
    ]);
}

export async function loadSalesforceActionTypes(
    opts: ActionTypeLoadOptions,
    query: MetaNameQuery = { type: "list" },
    window?: Pick<Query, "offset" | "limit">
): Promise<MetaActionType[]> {
    const describeCache = new Map<string, ReturnType<typeof loadSelectedActionDescribes>>();
    const requestedNames = query.type === "getBatch" ? new Set(query.names) : undefined;
    const configuredCrudNames = new Set(
        (opts.crudActionTypes ?? []).flatMap((selection) =>
            selection.operations.map((operation) =>
                salesforceCrudActionTypeName(operation, selection.objectType)
            )
        )
    );
    const [flowSummaries, standardSummaries] = await Promise.all([
        opts.flowActionTypeNames || requestedNames
            ? Promise.resolve(undefined)
            : opts.client.listFlowActions().then(normalizeFlowActionList),
        opts.standardActionTypeNames || requestedNames
            ? Promise.resolve(undefined)
            : opts.client.listStandardActions().then(normalizeFlowActionList),
    ]);
    const candidates: Array<{
        kind: "flow" | "standard";
        name: string;
        displayName: string;
    }> = [
        ...(
            opts.flowActionTypeNames ??
            (requestedNames
                ? [...requestedNames].filter((name) => !configuredCrudNames.has(name))
                : (flowSummaries?.map((summary) => summary.name) ?? []))
        ).map((name) => ({
            kind: "flow" as const,
            name,
            displayName: flowSummaries?.find((summary) => summary.name === name)?.label ?? name,
        })),
        ...(
            opts.standardActionTypeNames ??
            (requestedNames
                ? [...requestedNames].filter((name) => !configuredCrudNames.has(name))
                : (standardSummaries
                      ?.filter((summary) => classifySalesforceStandardAction(summary.name) === "action")
                      .map((summary) => summary.name) ?? []))
        ).map((name) => ({
            kind: "standard" as const,
            name,
            displayName: standardSummaries?.find((summary) => summary.name === name)?.label ?? name,
        })),
    ];
    const matchingCandidates =
        query.type === "search"
            ? candidates.filter((candidate) => matchesMetaNameQuery(query, candidate))
            : candidates;
    matchingCandidates.sort((left, right) => left.name.localeCompare(right.name));
    const offset = Math.max(0, Math.trunc(window?.offset ?? 0));
    const limit = window?.limit;
    const selectedCandidates = requestedNames
        ? matchingCandidates
        : matchingCandidates.slice(
              offset,
              limit === undefined ? undefined : offset + Math.max(0, Math.trunc(limit))
          );
    const names = selectedCandidates
        .filter((candidate) => candidate.kind === "flow")
        .map((candidate) => candidate.name);
    const standardNames = selectedCandidates
        .filter((candidate) => candidate.kind === "standard")
        .map((candidate) => candidate.name);
    const describeCacheKey = JSON.stringify([names, standardNames]);
    let cached = describeCache.get(describeCacheKey);
    if (!cached) {
        cached = loadSelectedActionDescribes(opts.client, names, standardNames);
        describeCache.set(describeCacheKey, cached);
    }
    const [describes, rawStandardDescribes] = await cached;
    const standardDescribes = rawStandardDescribes.filter(
        (describe): describe is SalesforceInvocableActionDescribe =>
            Boolean(describe) &&
            (opts.standardActionTypeNames !== undefined ||
                classifySalesforceStandardAction(describe!.name) === "action")
    );
    const flowDescribes = describes.filter((describe): describe is SalesforceInvocableActionDescribe =>
        Boolean(describe)
    );
    const sObjectNames = new Set((opts.crudActionTypes ?? []).map((selection) => selection.objectType));
    for (const describe of [...flowDescribes, ...standardDescribes]) {
        for (const input of describe.inputs ?? []) {
            const sObjectType = input.sobjectType ?? input.sObjectType;
            if (input.type?.toLowerCase() === "sobject" && sObjectType) {
                sObjectNames.add(sObjectType);
            }
        }
    }
    const sObjectDescribes = new Map<string, SalesforceSObjectDescribe>(
        await Promise.all(
            [...sObjectNames].map(async (name) => [name, await opts.client.describeSObject(name)] as const)
        )
    );
    const flowActions = flowDescribes.map((describe) =>
        convertSalesforceMetaActionType(describe, sObjectDescribes)
    );
    const standardActions = standardDescribes.map((describe) =>
        convertSalesforceMetaStandardActionType(describe, sObjectDescribes)
    );
    const crudActions = (opts.crudActionTypes ?? []).flatMap((selection) => {
        const describe = sObjectDescribes.get(selection.objectType);
        return describe
            ? synthesizeSalesforceCrudActionTypes(describe).filter(
                  (action) =>
                      (!requestedNames || requestedNames.has(action.name)) &&
                      matchesMetaNameQuery(query, action) &&
                      selection.operations.some(
                          (operation) =>
                              action.id === salesforceCrudActionTypeId(operation, selection.objectType)
                      )
              )
            : [];
    });
    const actions = new Map([...flowActions, ...standardActions].map((action) => [action.name, action]));
    for (const action of crudActions) {
        if (actions.has(action.name)) {
            throw new Error(`Multiple Salesforce actions use ontology name "${action.name}".`);
        }
        actions.set(action.name, action);
    }
    return [...actions.values()];
}
