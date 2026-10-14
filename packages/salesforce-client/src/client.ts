import { invariant } from "@bobbyfidz/panic";
import { SalesforceApiError } from "./errors.js";
import type {
    DescribeGlobalResult,
    DescribeSObjectResult,
    QueryResult,
    SalesforceChangeEvent,
    SalesforceChangeEventSubscription,
    SalesforceChangeEventSubscriptionOptions,
    SalesforceFetch,
    SalesforceInvocableActionDescribe,
    SalesforceInvocableActionDescribeRequest,
    SalesforceInvocableActionListResponse,
    SalesforceInvocableActionResult,
    SalesforceRecord,
    SalesforceSaveResult,
} from "./types.js";

export interface SalesforceClient {
    instanceUrl: string;
    apiVersion: string;
    tokenProvider?: () => Promise<string> | string;
    fetch: SalesforceFetch;
    request: <T>(
        path: string,
        init?: {
            method?: string;
            body?: unknown;
            headers?: Record<string, string>;
            searchParams?: Record<string, string | undefined>;
        }
    ) => Promise<T>;
    describeGlobal: () => Promise<DescribeGlobalResult>;
    describeSObject: (sObjectName: string) => Promise<DescribeSObjectResult>;
    query: <T extends SalesforceRecord = SalesforceRecord>(soql: string) => Promise<QueryResult<T>>;
    queryMore: <T extends SalesforceRecord = SalesforceRecord>(
        nextRecordsUrl: string
    ) => Promise<QueryResult<T>>;
    createRecord: (sObjectName: string, record: Record<string, unknown>) => Promise<SalesforceSaveResult>;
    updateRecord: (
        sObjectName: string,
        id: string,
        record: Record<string, unknown>
    ) => Promise<SalesforceSaveResult>;
    deleteRecord: (sObjectName: string, id: string) => Promise<SalesforceSaveResult>;
    subscribeToChangeEvents: (
        sObjectName: string,
        listener: (event: SalesforceChangeEvent) => void,
        options?: SalesforceChangeEventSubscriptionOptions
    ) => Promise<SalesforceChangeEventSubscription>;
    listFlowActions: () => Promise<SalesforceInvocableActionListResponse>;
    describeInvocableActions: (
        actions: readonly SalesforceInvocableActionDescribeRequest[]
    ) => Promise<Array<SalesforceInvocableActionDescribe | undefined>>;
    describeFlowAction: (apiName: string) => Promise<SalesforceInvocableActionDescribe>;
    describeFlowActions: (
        apiNames: readonly string[]
    ) => Promise<Array<SalesforceInvocableActionDescribe | undefined>>;
    invokeFlowAction: (
        apiName: string,
        inputs: Record<string, unknown>[]
    ) => Promise<SalesforceInvocableActionResult[]>;
    listStandardActions: () => Promise<SalesforceInvocableActionListResponse>;
    describeStandardAction: (apiName: string) => Promise<SalesforceInvocableActionDescribe>;
    describeStandardActions: (
        apiNames: readonly string[]
    ) => Promise<Array<SalesforceInvocableActionDescribe | undefined>>;
    invokeStandardAction: (
        apiName: string,
        inputs: Record<string, unknown>[]
    ) => Promise<SalesforceInvocableActionResult[]>;
}

interface CreateSalesforceClientBaseOptions {
    instanceUrl: string;
    apiVersion: string;
    /**
     * Optional full CometD endpoint, typically a same-origin relay for
     * browser clients that cannot retain Salesforce's cross-site Bayeux cookie.
     */
    cometdUrl?: string;
}

export type CreateSalesforceClientOptions = CreateSalesforceClientBaseOptions &
    (
        | {
              tokenProvider: () => Promise<string> | string;
              fetch?: SalesforceFetch;
              authenticatedFetch?: false;
          }
        | {
              /**
               * The supplied fetch implementation is responsible for adding
               * Salesforce authentication, typically through ConnectionEgress.
               */
              authenticatedFetch: true;
              fetch: SalesforceFetch;
              tokenProvider?: undefined;
          }
    );

function normalizeInstanceUrl(instanceUrl: string): string {
    return instanceUrl.replace(/\/+$/, "");
}

function normalizeApiVersion(apiVersion: string): string {
    const trimmed = apiVersion.trim();
    if (/^v?\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
    }
    throw new Error(`Invalid Salesforce API version "${apiVersion}".`);
}

function encodePathSegment(value: string): string {
    return encodeURIComponent(value);
}

function resolveUrl(instanceUrl: string, path: string): URL {
    if (/^https?:\/\//i.test(path)) {
        return new URL(path);
    }
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return new URL(`${instanceUrl}${normalizedPath}`);
}

function dataApiPath(apiVersion: string, path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `/services/data/v${apiVersion}${suffix}`;
}

const COMPOSITE_REQUEST_LIMIT = 25;

function changeEventChannel(sObjectName: string): string {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(sObjectName)) {
        throw new Error(`Invalid Salesforce sObject name "${sObjectName}".`);
    }
    const changeEventName = sObjectName.endsWith("__c")
        ? `${sObjectName.slice(0, -3)}__ChangeEvent`
        : `${sObjectName}ChangeEvent`;
    return `/data/${changeEventName}`;
}

export function createSalesforceClient(options: CreateSalesforceClientOptions): SalesforceClient {
    const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
    const apiVersion = normalizeApiVersion(options.apiVersion);
    const fetchImpl = options.fetch ?? fetch;
    const tokenProvider = options.tokenProvider;
    const cometdUrl = options.cometdUrl
        ? new URL(options.cometdUrl)
        : resolveUrl(instanceUrl, `/cometd/${apiVersion}`);

    invariant(instanceUrl.length > 0, "Salesforce instanceUrl is required.");
    invariant(
        typeof tokenProvider === "function" ||
            (options.authenticatedFetch === true && options.fetch !== undefined),
        "Salesforce tokenProvider or authenticated fetch is required."
    );

    const request = async <T>(
        path: string,
        init?: {
            method?: string;
            body?: unknown;
            headers?: Record<string, string>;
            searchParams?: Record<string, string | undefined>;
        }
    ): Promise<T> => {
        return (async () => {
            const url = resolveUrl(instanceUrl, path);
            for (const [key, value] of Object.entries(init?.searchParams ?? {})) {
                if (value !== undefined) {
                    url.searchParams.set(key, value);
                }
            }

            const method = (init?.method ?? (init?.body === undefined ? "GET" : "POST")).toUpperCase();
            const headers: Record<string, string> = { Accept: "application/json", ...init?.headers };
            if (init?.body !== undefined && !("Content-Type" in headers) && !("content-type" in headers)) {
                headers["Content-Type"] = "application/json";
            }

            if (tokenProvider) {
                headers.Authorization = `Bearer ${await tokenProvider()}`;
            }
            const response = await fetchImpl(url, {
                method,
                headers,
                body: init?.body === undefined ? undefined : JSON.stringify(init.body),
            });
            if (!response.ok) {
                const text = await response.text();
                let details: unknown = text;
                try {
                    details = JSON.parse(text);
                } catch {
                    // Preserve non-JSON Salesforce responses.
                }
                const first =
                    Array.isArray(details) && typeof details[0] === "object" && details[0] !== null
                        ? (details[0] as Record<string, unknown>)
                        : undefined;
                throw new SalesforceApiError(
                    typeof first?.message === "string"
                        ? first.message
                        : `Salesforce request failed with status ${response.status}.`,
                    {
                        statusCode: response.status,
                        errorCode: typeof first?.errorCode === "string" ? first.errorCode : undefined,
                        details,
                    }
                );
            }
            if (response.status === 204) {
                return undefined as T;
            }
            return (await response.json()) as T;
        })();
    };

    const describeInvocableActions = async (
        actions: readonly SalesforceInvocableActionDescribeRequest[]
    ): Promise<Array<SalesforceInvocableActionDescribe | undefined>> => {
        const describes: Array<SalesforceInvocableActionDescribe | undefined> = [];
        for (let offset = 0; offset < actions.length; offset += COMPOSITE_REQUEST_LIMIT) {
            const batch = actions.slice(offset, offset + COMPOSITE_REQUEST_LIMIT);
            const response = await request<{
                hasErrors: boolean;
                results: Array<{ result: SalesforceInvocableActionDescribe; statusCode: number }>;
            }>(dataApiPath(apiVersion, "/composite/batch"), {
                method: "POST",
                body: {
                    haltOnError: false,
                    batchRequests: batch.map((action) => ({
                        method: "GET",
                        url: `v${apiVersion}/actions/${action.kind === "flow" ? "custom/flow" : "standard"}/${encodePathSegment(action.apiName)}`,
                    })),
                },
            });
            describes.push(
                ...batch.map((_, index) => {
                    const entry = response.results[index];
                    return entry && entry.statusCode >= 200 && entry.statusCode < 300
                        ? entry.result
                        : undefined;
                })
            );
        }
        return describes;
    };

    const subscribeToChangeEvents = async (
        sObjectName: string,
        listener: (event: SalesforceChangeEvent) => void,
        subscriptionOptions?: SalesforceChangeEventSubscriptionOptions
    ): Promise<SalesforceChangeEventSubscription> => {
        if (!tokenProvider) {
            throw new Error("Salesforce Change Data Capture requires a tokenProvider.");
        }
        const channel = changeEventChannel(sObjectName);
        const controller = new AbortController();
        let messageId = 0;
        let replayId = subscriptionOptions?.replayId ?? -1;
        type CometdMessage = {
            advice?: { interval?: number; reconnect?: string };
            channel: string;
            clientId?: string;
            data?: SalesforceChangeEvent;
            error?: string;
            successful?: boolean;
        };
        const send = async (messages: Record<string, unknown>[]): Promise<CometdMessage[]> => {
            const token = await tokenProvider();
            invariant(token.length > 0, "Salesforce tokenProvider returned an empty token.");
            const response = await fetchImpl(cometdUrl, {
                method: "POST",
                credentials: "include",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(messages),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new SalesforceApiError(
                    `Salesforce CometD request failed with status ${response.status}.`,
                    { statusCode: response.status }
                );
            }
            return (await response.json()) as CometdMessage[];
        };
        const nextId = () => String(++messageId);
        const establish = async (): Promise<string> => {
            const handshake = (
                await send([
                    {
                        id: nextId(),
                        channel: "/meta/handshake",
                        version: "1.0",
                        minimumVersion: "1.0",
                        supportedConnectionTypes: ["long-polling"],
                        ext: { replay: true },
                    },
                ])
            )[0];
            if (!handshake?.successful || !handshake.clientId) {
                throw new Error(handshake?.error ?? "Salesforce CometD handshake failed.");
            }
            const subscription = (
                await send([
                    {
                        id: nextId(),
                        channel: "/meta/subscribe",
                        clientId: handshake.clientId,
                        subscription: channel,
                        ext: { replay: { [channel]: replayId } },
                    },
                ])
            )[0];
            if (!subscription?.successful) {
                throw new Error(subscription?.error ?? `Salesforce CDC subscription to "${channel}" failed.`);
            }
            return handshake.clientId;
        };
        let clientId = await establish();
        const connect = async () => {
            while (!controller.signal.aborted) {
                try {
                    const messages = await send([
                        { id: nextId(), channel: "/meta/connect", clientId, connectionType: "long-polling" },
                    ]);
                    for (const message of messages) {
                        if (message.channel !== channel || !message.data) {
                            continue;
                        }
                        const nextReplayId = message.data.event?.replayId;
                        if (nextReplayId !== undefined) {
                            replayId = nextReplayId;
                        }
                        listener(message.data);
                    }
                    const connectMessage = messages.find((message) => message.channel === "/meta/connect");
                    if (connectMessage?.advice?.reconnect === "none") {
                        break;
                    }
                    if (connectMessage?.advice?.reconnect === "handshake") {
                        clientId = await establish();
                    }
                    const interval = connectMessage?.advice?.interval ?? 0;
                    if (interval > 0) {
                        await new Promise((resolve) => setTimeout(resolve, interval));
                    }
                } catch {
                    if (controller.signal.aborted) {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                    clientId = await establish();
                }
            }
        };
        void connect().catch(() => undefined);
        return { channel, unsubscribe: () => controller.abort() };
    };

    return {
        instanceUrl,
        apiVersion,
        tokenProvider,
        fetch: fetchImpl,
        request,
        describeGlobal: () => request<DescribeGlobalResult>(dataApiPath(apiVersion, "/sobjects")),
        describeSObject: (sObjectName) =>
            request<DescribeSObjectResult>(
                dataApiPath(apiVersion, `/sobjects/${encodePathSegment(sObjectName)}/describe`)
            ),
        query: <T extends SalesforceRecord = SalesforceRecord>(soql: string) =>
            request<QueryResult<T>>(dataApiPath(apiVersion, "/query"), { searchParams: { q: soql } }),
        queryMore: <T extends SalesforceRecord = SalesforceRecord>(nextRecordsUrl: string) =>
            request<QueryResult<T>>(nextRecordsUrl),
        createRecord: (sObjectName, record) =>
            request<SalesforceSaveResult>(
                dataApiPath(apiVersion, `/sobjects/${encodePathSegment(sObjectName)}`),
                { method: "POST", body: record }
            ),
        updateRecord: async (sObjectName, id, record) => {
            await request<void>(
                dataApiPath(
                    apiVersion,
                    `/sobjects/${encodePathSegment(sObjectName)}/${encodePathSegment(id)}`
                ),
                { method: "PATCH", body: record }
            );
            return { id, success: true, errors: [] };
        },
        deleteRecord: async (sObjectName, id) => {
            await request<void>(
                dataApiPath(
                    apiVersion,
                    `/sobjects/${encodePathSegment(sObjectName)}/${encodePathSegment(id)}`
                ),
                { method: "DELETE" }
            );
            return { id, success: true, errors: [] };
        },
        subscribeToChangeEvents,
        listFlowActions: () =>
            request<SalesforceInvocableActionListResponse>(dataApiPath(apiVersion, "/actions/custom/flow")),
        describeInvocableActions,
        describeFlowAction: (apiName) =>
            request<SalesforceInvocableActionDescribe>(
                dataApiPath(apiVersion, `/actions/custom/flow/${encodePathSegment(apiName)}`)
            ),
        describeFlowActions: (apiNames) =>
            describeInvocableActions(apiNames.map((apiName) => ({ kind: "flow", apiName }))),
        invokeFlowAction: (apiName, inputs) =>
            request<SalesforceInvocableActionResult[]>(
                dataApiPath(apiVersion, `/actions/custom/flow/${encodePathSegment(apiName)}`),
                { method: "POST", body: { inputs } }
            ),
        listStandardActions: () =>
            request<SalesforceInvocableActionListResponse>(dataApiPath(apiVersion, "/actions/standard")),
        describeStandardAction: (apiName) =>
            request<SalesforceInvocableActionDescribe>(
                dataApiPath(apiVersion, `/actions/standard/${encodePathSegment(apiName)}`)
            ),
        describeStandardActions: (apiNames) =>
            describeInvocableActions(apiNames.map((apiName) => ({ kind: "standard", apiName }))),
        invokeStandardAction: (apiName, inputs) =>
            request<SalesforceInvocableActionResult[]>(
                dataApiPath(apiVersion, `/actions/standard/${encodePathSegment(apiName)}`),
                { method: "POST", body: { inputs } }
            ),
    };
}
