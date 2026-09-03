/**
 * Keep the Salesforce Flow API name as the ontology action name.
 * Camel-casing would be lossy for names like `Create_Account`.
 */
export function toOntologyActionTypeName(salesforceFlowApiName: string): string {
    return salesforceFlowApiName;
}

export function salesforceObjectTypeId(sObjectName: string): string {
    return `salesforce:sobject:${sObjectName}`;
}

export function salesforcePropertyId(sObjectName: string, fieldName: string): string {
    return `salesforce:field:${sObjectName}.${fieldName}`;
}

export function salesforceLinkTypeId(sObjectName: string, fieldName: string): string {
    return `salesforce:link:${sObjectName}.${fieldName}`;
}

export function salesforceFlowActionTypeId(flowApiName: string): string {
    return `salesforce:flow:${flowApiName}`;
}
