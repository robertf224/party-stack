import type {
    DescribeGlobalResult,
    DescribeSObjectResult,
    Field,
    QueryResult,
    Record as JsforceRecord,
} from "@jsforce/jsforce-node";

/**
 * Re-export jsforce describe/query types as the Salesforce client contract.
 * @see https://github.com/jsforce/jsforce
 */
export type {
    DescribeGlobalResult,
    DescribeSObjectResult,
    Field,
    QueryResult,
    JsforceRecord as SalesforceRecord,
};

/** Party aliases kept for adapter readability. */
export type SalesforceSObjectDescribe = DescribeSObjectResult;
export type SalesforceFieldDescribe = Field;
export type SalesforceGlobalDescribeResponse = DescribeGlobalResult;
export type SalesforceQueryResponse<T extends JsforceRecord = JsforceRecord> = QueryResult<T>;

/**
 * jsforce types `Field.picklistValues` as `any[]`; this is the shape Salesforce returns.
 */
export interface SalesforcePicklistValue {
    active: boolean;
    defaultValue: boolean;
    label: string | null;
    value: string;
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
    apexClass?: string | null;
    sobjectType?: string | null;
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

export interface SalesforceChangeEventHeader {
    entityName: string;
    changeType: "CREATE" | "UPDATE" | "DELETE" | "UNDELETE" | "GAP_OVERFLOW";
    changedFields?: string[];
    recordIds: string[];
    commitTimestamp?: number;
    commitUser?: string;
    sequenceNumber?: number;
    transactionKey?: string;
}

export interface SalesforceChangeEvent<
    Payload extends Record<string, unknown> = Record<string, unknown>,
> {
    event?: {
        replayId?: number;
    };
    schema?: string;
    payload: Payload & {
        ChangeEventHeader: SalesforceChangeEventHeader;
    };
}

export interface SalesforceChangeEventSubscription {
    channel: string;
    unsubscribe: () => void;
}

export type SalesforceFetch = typeof fetch;
