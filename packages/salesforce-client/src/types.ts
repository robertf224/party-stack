/**
 * Salesforce REST API shapes used by Party Stack.
 */
export interface SalesforcePicklistValue {
    active: boolean;
    defaultValue: boolean;
    label: string | null;
    value: string;
}

export interface SalesforceFieldDescribe {
    autoNumber: boolean;
    calculated: boolean;
    createable: boolean;
    defaultedOnCreate: boolean;
    inlineHelpText?: string | null;
    label: string;
    name: string;
    nillable: boolean;
    picklistValues: SalesforcePicklistValue[];
    referenceTo?: string[];
    relationshipName?: string | null;
    type: string;
    updateable: boolean;
    [key: string]: unknown;
}

export type Field = SalesforceFieldDescribe;

export interface SalesforceSObjectDescribe {
    createable: boolean;
    deletable: boolean;
    fields: SalesforceFieldDescribe[];
    label: string;
    labelPlural: string;
    name: string;
    queryable: boolean;
    updateable: boolean;
    [key: string]: unknown;
}

export type DescribeSObjectResult = SalesforceSObjectDescribe;

export interface SalesforceGlobalSObjectSummary {
    label: string;
    labelPlural: string;
    name: string;
    queryable: boolean;
    [key: string]: unknown;
}

export interface SalesforceGlobalDescribeResponse {
    encoding?: string;
    maxBatchSize?: number;
    sobjects: SalesforceGlobalSObjectSummary[];
}

export type DescribeGlobalResult = SalesforceGlobalDescribeResponse;

export interface SalesforceRecord {
    attributes?: {
        type?: string;
        url?: string;
    };
    [key: string]: unknown;
}

export interface SalesforceQueryResponse<T extends SalesforceRecord = SalesforceRecord> {
    done: boolean;
    nextRecordsUrl?: string;
    records: T[];
    totalSize: number;
}

export type QueryResult<T extends SalesforceRecord = SalesforceRecord> = SalesforceQueryResponse<T>;

export interface SalesforceSaveResult {
    errors: Array<{
        fields?: string[];
        message: string;
        statusCode?: string;
    }>;
    id?: string;
    success: boolean;
}

/**
 * Invocable Actions / Flow REST shapes — not modeled by jsforce.
 * @see https://developer.salesforce.com/docs/atlas.en-us.api_action.meta/api_action/actions_intro.htm
 */
export interface SalesforceInvocableActionSummary {
    name: string;
    label?: string;
    type?: string;
    url?: string;
}

export interface SalesforceInvocableActionParameter {
    name: string;
    label?: string;
    type?: string | null;
    description?: string;
    required?: boolean;
    maxOccurs?: number | null;
    picklistValues?: SalesforcePicklistValue[] | null;
    apexClass?: string | null;
    sobjectType?: string | null;
    /** Salesforce uses this casing on some Flow input describes. */
    sObjectType?: string | null;
}

export interface SalesforceInvocableActionDescribe {
    name: string;
    label?: string;
    description?: string;
    type?: string;
    category?: string;
    inputs?: SalesforceInvocableActionParameter[];
    outputs?: SalesforceInvocableActionParameter[];
}

export interface SalesforceInvocableActionDescribeRequest {
    kind: "flow" | "standard";
    apiName: string;
}

export type SalesforceInvocableActionListResponse =
    | SalesforceInvocableActionSummary[]
    | {
          actions?: SalesforceInvocableActionSummary[];
      }
    | Record<string, string>;

export interface SalesforceInvocableActionResult {
    actionName?: string;
    isSuccess: boolean;
    errors?: Array<{
        statusCode?: string;
        message?: string;
        fields?: string[];
    }>;
    outputValues?: Record<string, unknown> | null;
}

export type SalesforceFetch = typeof fetch;
