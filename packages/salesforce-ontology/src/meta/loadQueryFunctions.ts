import { classifySalesforceStandardAction } from "../standardActions.js";
import { matchesMetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import { convertSalesforceMetaStandardQueryFunctionType } from "./convertMetaQueryFunctionType.js";
import type { MetaNameQuery } from "./convertMetaLoadSubsetOptions.js";
import type { QueryFunctionTypeDef } from "@party-stack/ontology";
import type { Query } from "@party-stack/ontology-storage";
import type {
    SalesforceClient,
    SalesforceInvocableActionDescribe,
    SalesforceInvocableActionSummary,
    SalesforceSObjectDescribe,
} from "@party-stack/salesforce-client";

async function describeStandardActions(
    client: SalesforceClient,
    names: readonly string[]
): Promise<Array<SalesforceInvocableActionDescribe | undefined>> {
    if (typeof client.describeStandardActions === "function") {
        try {
            return await client.describeStandardActions(names);
        } catch {
            // Fall through when Composite API access is unavailable.
        }
    }
    return Promise.all(
        names.map(async (name) => {
            try {
                return await client.describeStandardAction(name);
            } catch {
                return undefined;
            }
        })
    );
}

export async function loadSalesforceQueryFunctionTypes(
    opts: { client: SalesforceClient; standardQueryFunctionTypeNames?: string[] },
    query: MetaNameQuery = { type: "list" },
    window?: Pick<Query, "offset" | "limit">
): Promise<QueryFunctionTypeDef[]> {
    let summaries: SalesforceInvocableActionSummary[] | undefined;
    if (query.type !== "getBatch" && !opts.standardQueryFunctionTypeNames) {
        const response = await opts.client.listStandardActions();
        summaries = Array.isArray(response)
            ? response
            : Array.isArray(response.actions)
              ? response.actions
              : Object.keys(response).map((name) => ({ name }));
    }
    const requestedNames = query.type === "getBatch" ? new Set(query.names) : undefined;
    const candidates = (
        opts.standardQueryFunctionTypeNames ??
        (requestedNames ? [...requestedNames] : (summaries?.map((summary) => summary.name) ?? []))
    )
        .filter(
            (name) =>
                (!requestedNames || requestedNames.has(name)) &&
                (opts.standardQueryFunctionTypeNames !== undefined ||
                    classifySalesforceStandardAction(name) === "queryFunction")
        )
        .map((name) => ({
            name,
            displayName: summaries?.find((summary) => summary.name === name)?.label ?? name,
        }))
        .filter((candidate) => matchesMetaNameQuery(query, candidate));
    const offset = Math.max(0, Math.trunc(window?.offset ?? 0));
    const limit = window?.limit;
    const names = (
        requestedNames
            ? candidates
            : candidates.slice(
                  offset,
                  limit === undefined ? undefined : offset + Math.max(0, Math.trunc(limit))
              )
    ).map((candidate) => candidate.name);
    const describes = (await describeStandardActions(opts.client, names)).filter(
        (describe): describe is SalesforceInvocableActionDescribe => Boolean(describe)
    );
    const sObjectNames = new Set<string>();
    for (const describe of describes) {
        for (const parameter of [...(describe.inputs ?? []), ...(describe.outputs ?? [])]) {
            const name = parameter.sobjectType ?? parameter.sObjectType;
            if (name) sObjectNames.add(name);
        }
    }
    const sObjectDescribes = new Map<string, SalesforceSObjectDescribe>(
        await Promise.all(
            [...sObjectNames].map(async (name) => [name, await opts.client.describeSObject(name)] as const)
        )
    );
    return describes.map((describe) =>
        convertSalesforceMetaStandardQueryFunctionType(describe, sObjectDescribes)
    );
}
