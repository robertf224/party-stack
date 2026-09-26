import {
    fromSalesforceLightningIconName,
    getSalesforceActionIconName,
} from "@party-stack/icons-salesforce-lightning";
import type { MetaActionType } from "@party-stack/ontology";
import type {
    SalesforceInvocableActionDescribe,
    SalesforceSObjectDescribe,
} from "@party-stack/salesforce-client";
import { salesforceActionMeta } from "../actionMetadata.js";
import {
    salesforceFlowActionTypeId,
    salesforceStandardActionTypeId,
    toOntologyActionTypeName,
} from "../utils/ids.js";
import { convertSalesforceInvocableParameterType } from "./convertMetaTypeDef.js";

/**
 * Convert an autolaunched Flow describe into a Party Stack action type.
 * Local `logic` stays empty because execution remains native to Salesforce.
 */
function convertSalesforceInvocableMetaActionType(
    describe: SalesforceInvocableActionDescribe,
    id: string,
    kind: "flow" | "standard",
    sObjectDescribes: ReadonlyMap<
        string,
        SalesforceSObjectDescribe
    > = new Map()
): MetaActionType {
    return {
        id,
        meta: salesforceActionMeta({
            kind,
            apiName: describe.name,
        }),
        name: toOntologyActionTypeName(describe.name),
        displayName: describe.label ?? describe.name,
        description: describe.description,
        icon: fromSalesforceLightningIconName(getSalesforceActionIconName(describe.name)),
        parameters: (describe.inputs ?? []).map((parameter) => ({
            name: parameter.name,
            displayName: parameter.label ?? parameter.name,
            description: parameter.description,
            type: convertSalesforceInvocableParameterType(
                parameter,
                parameter.sobjectType ??
                    parameter.sObjectType
                    ? sObjectDescribes.get(
                          (parameter.sobjectType ??
                              parameter.sObjectType)!
                      )
                    : undefined
            ),
        })),
        logic: [],
    };
}

export function convertSalesforceMetaActionType(
    describe: SalesforceInvocableActionDescribe,
    sObjectDescribes: ReadonlyMap<
        string,
        SalesforceSObjectDescribe
    > = new Map()
): MetaActionType {
    return convertSalesforceInvocableMetaActionType(
        describe,
        salesforceFlowActionTypeId(describe.name),
        "flow",
        sObjectDescribes
    );
}

export function convertSalesforceMetaStandardActionType(
    describe: SalesforceInvocableActionDescribe,
    sObjectDescribes: ReadonlyMap<
        string,
        SalesforceSObjectDescribe
    > = new Map()
): MetaActionType {
    return convertSalesforceInvocableMetaActionType(
        describe,
        salesforceStandardActionTypeId(describe.name),
        "standard",
        sObjectDescribes
    );
}
