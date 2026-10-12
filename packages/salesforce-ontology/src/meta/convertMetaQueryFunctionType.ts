import { convertSalesforceInvocableParameterType } from "./convertMetaTypeDef.js";
import type { QueryFunctionTypeDef } from "@party-stack/ontology";
import type {
    SalesforceInvocableActionDescribe,
    SalesforceInvocableActionParameter,
    SalesforceSObjectDescribe,
} from "@party-stack/salesforce-client";

function sObjectDescribeFor(
    parameter: SalesforceInvocableActionParameter,
    describes: ReadonlyMap<string, SalesforceSObjectDescribe>
): SalesforceSObjectDescribe | undefined {
    const name = parameter.sobjectType ?? parameter.sObjectType;
    return name ? describes.get(name) : undefined;
}

export function convertSalesforceMetaStandardQueryFunctionType(
    describe: SalesforceInvocableActionDescribe,
    sObjectDescribes: ReadonlyMap<string, SalesforceSObjectDescribe> = new Map()
): QueryFunctionTypeDef {
    return {
        name: describe.name,
        displayName: describe.label ?? describe.name,
        description: describe.description,
        parameters: (describe.inputs ?? []).map((parameter) => ({
            name: parameter.name,
            displayName: parameter.label ?? parameter.name,
            description: parameter.description,
            type: convertSalesforceInvocableParameterType(
                parameter,
                sObjectDescribeFor(parameter, sObjectDescribes)
            ),
        })),
        returnType: {
            kind: "struct",
            value: {
                fields: (describe.outputs ?? []).map((output) => ({
                    name: output.name,
                    displayName: output.label ?? output.name,
                    description: output.description,
                    type: convertSalesforceInvocableParameterType(
                        output,
                        sObjectDescribeFor(output, sObjectDescribes)
                    ),
                })),
            },
        },
    };
}
