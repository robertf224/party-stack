import type { MetaActionType } from "@party-stack/ontology";
import type { SalesforceInvocableActionDescribe } from "@party-stack/salesforce-client";
import { salesforceFlowActionTypeId, toOntologyActionTypeName } from "../utils/ids.js";
import { convertSalesforceInvocableParameterType } from "./convertMetaTypeDef.js";

/**
 * Convert an autolaunched Flow describe into a Party Stack action type.
 * Local `logic` stays empty because execution remains native to Salesforce.
 */
export function convertSalesforceMetaActionType(
    describe: SalesforceInvocableActionDescribe
): MetaActionType {
    return {
        id: salesforceFlowActionTypeId(describe.name),
        name: toOntologyActionTypeName(describe.name),
        displayName: describe.label ?? describe.name,
        description: describe.description,
        parameters: (describe.inputs ?? []).map((parameter) => ({
            name: parameter.name,
            displayName: parameter.label ?? parameter.name,
            description: parameter.description,
            type: convertSalesforceInvocableParameterType(parameter),
        })),
        logic: [],
    };
}

export function getSalesforceFlowApiNameFromActionType(actionType: {
    id?: string;
    name: string;
}): string {
    if (typeof actionType.id === "string" && actionType.id.startsWith("salesforce:flow:")) {
        return actionType.id.slice("salesforce:flow:".length);
    }
    return actionType.name;
}
