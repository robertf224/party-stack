import { PassThrough } from "node:stream";
import { invariant } from "@bobbyfidz/panic";
import {
    Connection,
    type DescribeGlobalResult,
    type DescribeSObjectResult,
    type HttpRequest,
    type QueryResult,
    type Record as SalesforceRecord,
    type SaveResult,
} from "@jsforce/jsforce-node";
import { SalesforceApiError } from "./errors.js";
import type {
    SalesforceChangeEvent,
    SalesforceChangeEventSubscription,
    SalesforceFetch,
    SalesforceInvocableActionDescribe,
    SalesforceInvocableActionListResponse,
    SalesforceInvocableActionResult,
} from "./types.js";

export interface SalesforceClient {
    instanceUrl: string;
    apiVersion: string;
    tokenProvider?: () => Promise<string> | string;
    fetch: SalesforceFetch;
    /** Underlying jsforce connection. Prefer the typed helpers when possible. */
    connection: Connection;
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
    createRecord: (
        sObjectName: string,
        record: Record<string, unknown>
    ) => Promise<SaveResult>;
    updateRecord: (
        sObjectName: string,
        id: string,
        record: Record<string, unknown>
    ) => Promise<SaveResult>;
    deleteRecord: (sObjectName: string, id: string) => Promise<SaveResult>;
    subscribeToChangeEvents: (
        sObjectName: string,
        listener: (event: SalesforceChangeEvent) => void
    ) => Promise<SalesforceChangeEventSubscription>;
    listFlowActions: () => Promise<SalesforceInvocableActionListResponse>;
    describeFlowAction: (apiName: string) => Promise<SalesforceInvocableActionDescribe>;
    invokeFlowAction: (
        apiName: string,
        inputs: Record<string, unknown>[]
    ) => Promise<SalesforceInvocableActionResult[]>;
}

interface CreateSalesforceClientBaseOptions {
    instanceUrl: string;
    apiVersion: string;
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

function changeEventChannel(sObjectName: string): string {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(sObjectName)) {
        throw new Error(`Invalid Salesforce sObject name "${sObjectName}".`);
    }
    const changeEventName = sObjectName.endsWith("__c")
        ? `${sObjectName.slice(0, -3)}__ChangeEvent`
        : `${sObjectName}ChangeEvent`;
    return `/data/${changeEventName}`;
}

type JsforceApiError = Error & {
    errorCode?: string;
    data?: unknown;
};

function isJsforceApiError(error: unknown): error is JsforceApiError {
    return (
        error instanceof Error &&
        "errorCode" in error &&
        (typeof (error as JsforceApiError).errorCode === "string" ||
            (error as JsforceApiError).errorCode === undefined)
    );
}

function mapJsforceError(error: unknown): never {
    if (error instanceof SalesforceApiError) {
        throw error;
    }
    if (isJsforceApiError(error)) {
        const httpMatch =
            typeof error.errorCode === "string" ? /^ERROR_HTTP_(\d+)$/.exec(error.errorCode) : null;
        // Structured Salesforce REST errors are client/request failures; preserve HTTP status when present.
        const statusCode = httpMatch
            ? Number(httpMatch[1])
            : typeof error.errorCode === "string" && error.errorCode.length > 0
              ? 400
              : 500;
        throw new SalesforceApiError(error.message, {
            statusCode,
            errorCode: error.errorCode,
            details: error.data,
        });
    }
    throw error;
}

/**
 * jsforce uses undici internally. When callers provide `fetch` (tests/custom agents),
 * replace the connection transport with a minimal fetch-backed shim.
 */
function serializeFetchBody(body: HttpRequest["body"]): string {
    if (typeof body === "string") {
        return body;
    }
    if (Buffer.isBuffer(body)) {
        return body.toString("utf8");
    }
    throw new Error("Unsupported Salesforce request body type for fetch transport.");
}

function installFetchTransport(connection: Connection, fetchImpl: SalesforceFetch): void {
    connection._transport.httpRequest = ((req: HttpRequest) => {
        const stream = new PassThrough();
        // The returned promise is the authoritative error channel. Avoid an
        // unhandled stream error when a fetch fails before jsforce consumes it.
        stream.on("error", () => undefined);
        const promise = (async () => {
            const method = req.method ?? "GET";
            const body =
                req.body === undefined || req.body === null || method === "GET" || method === "HEAD"
                    ? undefined
                    : serializeFetchBody(req.body);
            const requestHeaders = new Headers(
                req.headers
            );
            // jsforce calculates this for its native transport. The fetch
            // bridge reconstructs the body, so undici must calculate it again.
            requestHeaders.delete("content-length");

            const response = await fetchImpl(req.url, {
                method,
                headers: requestHeaders,
                body,
            });
            const responseBody = await response.text();
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });
            return {
                statusCode: response.status,
                headers,
                body: responseBody,
            };
        })();

        void promise.then(
            (result) => {
                stream.end(result.body);
            },
            (error: unknown) => {
                stream.destroy(error instanceof Error ? error : new Error(String(error)));
            }
        );

        return Object.assign(promise, {
            stream: () => stream,
        });
    }) as typeof connection._transport.httpRequest;
}

export function createSalesforceClient(options: CreateSalesforceClientOptions): SalesforceClient {
    const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
    const apiVersion = normalizeApiVersion(options.apiVersion);
    const fetchImpl = options.fetch ?? fetch;
    const tokenProvider = options.tokenProvider;

    invariant(instanceUrl.length > 0, "Salesforce instanceUrl is required.");
    invariant(
        typeof tokenProvider === "function" ||
            (options.authenticatedFetch === true && options.fetch !== undefined),
        "Salesforce tokenProvider or authenticated fetch is required."
    );

    const connection = new Connection({
        instanceUrl,
        version: apiVersion,
        ...(tokenProvider
            ? {
                  refreshFn: (_conn, callback) => {
                      void Promise.resolve()
                          .then(() => tokenProvider())
                          .then((token) => {
                              invariant(
                                  typeof token === "string" && token.length > 0,
                                  "Salesforce tokenProvider returned an empty token."
                              );
                              callback(null, token);
                          })
                          .catch((error: unknown) => {
                              callback(error instanceof Error ? error : new Error(String(error)));
                          });
                  },
              }
            : {}),
    });

    if (options.fetch) {
        installFetchTransport(connection, options.fetch);
    }

    const withAuth = async <T>(run: () => Promise<T>): Promise<T> => {
        if (tokenProvider) {
            const token = await tokenProvider();
            invariant(
                typeof token === "string" && token.length > 0,
                "Salesforce tokenProvider returned an empty token."
            );
            connection.accessToken = token;
        }
        try {
            return await run();
        } catch (error) {
            mapJsforceError(error);
        }
    };

    const request = async <T>(
        path: string,
        init?: {
            method?: string;
            body?: unknown;
            headers?: Record<string, string>;
            searchParams?: Record<string, string | undefined>;
        }
    ): Promise<T> => {
        return withAuth(async () => {
            const url = resolveUrl(instanceUrl, path);
            for (const [key, value] of Object.entries(init?.searchParams ?? {})) {
                if (value !== undefined) {
                    url.searchParams.set(key, value);
                }
            }

            const method = (init?.method ?? (init?.body === undefined ? "GET" : "POST")).toUpperCase();
            const headers: Record<string, string> = {
                Accept: "application/json",
                ...init?.headers,
            };
            if (init?.body !== undefined && !("Content-Type" in headers) && !("content-type" in headers)) {
                headers["Content-Type"] = "application/json";
            }

            return (await connection.request({
                method: method as HttpRequest["method"],
                url: url.toString(),
                headers,
                body: init?.body === undefined ? undefined : JSON.stringify(init.body),
            })) as T;
        });
    };

    return {
        instanceUrl,
        apiVersion,
        tokenProvider,
        fetch: fetchImpl,
        connection,
        request,
        describeGlobal: () => withAuth(() => connection.describeGlobal()),
        describeSObject: (sObjectName) => withAuth(() => connection.describe(sObjectName)),
        query: <T extends SalesforceRecord = SalesforceRecord>(soql: string) =>
            withAuth(async () => await connection.query<T>(soql)),
        queryMore: <T extends SalesforceRecord = SalesforceRecord>(nextRecordsUrl: string) =>
            withAuth(async () => await connection.queryMore<T>(nextRecordsUrl)),
        createRecord: (sObjectName, record) =>
            withAuth(() => connection.create(sObjectName, record)),
        updateRecord: (sObjectName, id, record) =>
            withAuth(() => connection.update(sObjectName, { ...record, Id: id })),
        deleteRecord: (sObjectName, id) =>
            withAuth(() => connection.destroy(sObjectName, id)),
        subscribeToChangeEvents: (sObjectName, listener) =>
            withAuth(async () => {
                if (!connection.accessToken) {
                    throw new Error(
                        "Salesforce Change Data Capture requires a tokenProvider because jsforce streaming bypasses fetch egress."
                    );
                }
                const channel = changeEventChannel(sObjectName);
                const subscription = connection.streaming.subscribe(
                    channel,
                    (event: SalesforceChangeEvent) => listener(event)
                );
                await subscription;
                return {
                    channel,
                    unsubscribe: () => subscription.cancel(),
                };
            }),
        listFlowActions: () =>
            request<SalesforceInvocableActionListResponse>(dataApiPath(apiVersion, "/actions/custom/flow")),
        describeFlowAction: (apiName) =>
            request<SalesforceInvocableActionDescribe>(
                dataApiPath(apiVersion, `/actions/custom/flow/${encodePathSegment(apiName)}`)
            ),
        invokeFlowAction: (apiName, inputs) =>
            request<SalesforceInvocableActionResult[]>(
                dataApiPath(apiVersion, `/actions/custom/flow/${encodePathSegment(apiName)}`),
                {
                    method: "POST",
                    body: { inputs },
                }
            ),
    };
}
