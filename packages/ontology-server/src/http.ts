import {
    BackendSnapshotSchema,
    BackendChangePageSchema,
    DecryptedValueSchema,
} from "@party-stack/ontology-backend";
import { collectByteBlob } from "@party-stack/ontology-storage/blobs";
import { decode, encode } from "@party-stack/ontology/json";
import { Effect } from "effect";
import { Schema } from "effect";
import { parseRemoteOntologyErrorBody } from "./errors.js";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";
import type {
    RemoteApplyActionResponse,
    RemoteAttachmentMetadataRequest,
    RemoteAttachmentRequest,
    RemoteResolveActionParametersResponse,
    RemoteRunQueryFunctionResponse,
    RemoteLoadSubsetResponse,
    RemoteOntologyDescription,
    RemoteOntologyTransportOptions,
    ResolvableRemoteOntologyTransport,
} from "./protocol.js";
import type { RemoteOntologyServer } from "./server.js";
import type {
    OntologyIR,
    PartialAttachmentMetadata,
    Uncertain,
    ValidationIssue,
} from "@party-stack/ontology";
import type { Result } from "@party-stack/ontology/values";

export interface HttpRemoteOntologyTransportOptions {
    url: string | URL;
    ir?: OntologyIR;
    fetch?: typeof fetch;
    headers?: HeadersInit | (() => HeadersInit);
}

export interface InProcessHttpRemoteOntologyTransportOptions {
    headers?: HeadersInit | (() => HeadersInit);
    ir?: OntologyIR;
}

function resolveEndpoint(baseUrl: string | URL, path: string): string {
    const base = baseUrl instanceof URL ? baseUrl.toString() : baseUrl;
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    if (/^[a-z][a-z\d+\-.]*:/i.test(normalizedBase)) {
        return new URL(path, normalizedBase).toString();
    }
    return `${normalizedBase}${path}`;
}

async function throwIfNotOk(response: Response): Promise<void> {
    if (response.ok) return;
    const message = await response.text();
    throw parseRemoteOntologyErrorBody(message, response.status);
}

async function postJson<TResponse>(
    fetchImpl: typeof fetch,
    url: string,
    body: unknown,
    headers?: HeadersInit,
    options?: RemoteOntologyTransportOptions
): Promise<TResponse> {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    const response = await fetchImpl(url, {
        method: "POST",
        headers: requestHeaders,
        body: serializeRemoteOntologyJson(body),
        signal: options?.signal,
    });

    await throwIfNotOk(response);
    return parseRemoteOntologyJson(await response.text()) as TResponse;
}

function isWebKitRuntime(): boolean {
    const userAgent = globalThis.navigator?.userAgent;
    if (!userAgent || !/\bAppleWebKit\//.test(userAgent)) return false;

    // Blink-based browsers retain "AppleWebKit" in their user agent. Keep iOS browser tokens
    // such as CriOS and EdgiOS because all browsers on iOS use WebKit.
    return !/\b(?:Android|Chrome|Chromium|EdgA?|OPR)\b/.test(userAgent);
}

async function postMultipart<TResponse>(
    fetchImpl: typeof fetch,
    url: string,
    body: unknown,
    headers?: HeadersInit,
    options?: RemoteOntologyTransportOptions
): Promise<TResponse> {
    const formData = new FormData();
    formData.append("payload", serializeRemoteOntologyJson(body));
    for (const upload of options?.attachments ?? []) {
        // Temporary workaround for WebKit regressions that can serialize OPFS-backed files as
        // an empty multipart body. Remove after https://bugs.webkit.org/show_bug.cgi?id=319985
        // and https://bugs.webkit.org/show_bug.cgi?id=319396 are fixed in supported Safari versions.
        const blob =
            upload.blob instanceof Blob ? upload.blob : await Effect.runPromise(collectByteBlob(upload.blob));
        const safeBlob = isWebKitRuntime() ? new Blob([await blob.arrayBuffer()], { type: blob.type }) : blob;
        formData.append(
            `attachment:${upload.attachment.id}`,
            safeBlob,
            "name" in upload.blob && typeof upload.blob.name === "string"
                ? upload.blob.name
                : upload.attachment.id
        );
    }

    const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: formData,
        signal: options?.signal,
    });

    await throwIfNotOk(response);
    return parseRemoteOntologyJson(await response.text()) as TResponse;
}

async function postBlob(
    fetchImpl: typeof fetch,
    url: string,
    body: unknown,
    headers?: HeadersInit,
    options?: RemoteOntologyTransportOptions
): Promise<Blob> {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("content-type", "application/json");
    const response = await fetchImpl(url, {
        method: "POST",
        headers: requestHeaders,
        body: serializeRemoteOntologyJson(body),
        signal: options?.signal,
    });

    await throwIfNotOk(response);
    return response.blob();
}

/** @deprecated Use makeOntologyServer / connectOntologyBackendHttp with scoped native backends. */
export function createHttpRemoteOntologyTransport(
    opts: HttpRemoteOntologyTransportOptions
): ResolvableRemoteOntologyTransport {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const getHeaders = () => (typeof opts.headers === "function" ? opts.headers() : opts.headers);
    let ir = opts.ir;
    let actionValidationSupported: boolean | undefined;
    let actionParameterResolutionSupported: boolean | undefined;
    const getIr = () => {
        if (!ir) {
            throw new Error(
                "HTTP remote ontology transport must describe the ontology before typed requests."
            );
        }
        return ir;
    };

    return {
        sourceId: String(opts.url),
        decrypt: async (request, options) =>
            Schema.decodeUnknownSync(DecryptedValueSchema)(
                await postJson<unknown>(
                    fetchImpl,
                    resolveEndpoint(opts.url, "decrypt"),
                    request,
                    getHeaders(),
                    options
                )
            ),
        replicaSnapshot: async (request, options) => {
            const snapshot = Schema.decodeUnknownSync(BackendSnapshotSchema)(
                await postJson<unknown>(
                    fetchImpl,
                    resolveEndpoint(opts.url, "replica-snapshot"),
                    request,
                    getHeaders(),
                    options
                )
            );
            return {
                ...snapshot,
                rows: snapshot.rows.map((row) => ({
                    ...row,
                    value: decode({
                        ir: getIr(),
                        target: { kind: "object", name: request.objectType },
                        value: row.value,
                    }) as Record<string, unknown>,
                })),
            };
        },
        pullChanges: async (request, options) => {
            const page = Schema.decodeUnknownSync(BackendChangePageSchema)(
                await postJson<unknown>(
                    fetchImpl,
                    resolveEndpoint(opts.url, "pull-changes"),
                    request,
                    getHeaders(),
                    options
                )
            );
            return {
                ...page,
                commits: page.commits.map((commit) => ({
                    ...commit,
                    changes: commit.changes.map((change) =>
                        change.kind === "put"
                            ? {
                                  ...change,
                                  value: decode({
                                      ir: getIr(),
                                      target: { kind: "object", name: change.objectType },
                                      value: change.value,
                                  }) as Record<string, unknown>,
                              }
                            : change
                    ),
                })),
            };
        },
        describe: async (options) => {
            const description = await postJson<RemoteOntologyDescription>(
                fetchImpl,
                resolveEndpoint(opts.url, "describe"),
                {},
                getHeaders(),
                options
            );
            ir = description.ir;
            actionValidationSupported = description.capabilities?.actionValidation === true;
            actionParameterResolutionSupported = description.capabilities?.actionParameterResolution === true;
            return description;
        },
        loadSubset: async (request, options) => {
            const response = await postJson<RemoteLoadSubsetResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "load-subset"),
                request,
                getHeaders(),
                options
            );
            return {
                ...response,
                objects: response.objects.map(
                    (object) =>
                        decode({
                            ir: getIr(),
                            target: { kind: "object", name: response.objectType },
                            value: object,
                        }) as Record<string, unknown>
                ),
            };
        },
        applyAction: (request, options) => {
            const ontology = getIr();
            const body = {
                ...request,
                parameters: encode({
                    ir: ontology,
                    target: { kind: "actionParameters", actionType: request.actionType },
                    value: request.parameters,
                }) as Record<string, unknown>,
            };
            const hasAttachments = options?.attachments && options.attachments.length > 0;
            return hasAttachments
                ? postMultipart<RemoteApplyActionResponse>(
                      fetchImpl,
                      resolveEndpoint(opts.url, "apply-action"),
                      body,
                      getHeaders(),
                      options
                  )
                : postJson<RemoteApplyActionResponse>(
                      fetchImpl,
                      resolveEndpoint(opts.url, "apply-action"),
                      body,
                      getHeaders(),
                      options
                  );
        },
        validateAction: (request, options) => {
            if (actionValidationSupported === false) {
                return Promise.resolve({
                    certain: false,
                });
            }
            const ontology = getIr();
            return postJson<Uncertain<Result<null, readonly ValidationIssue[]>>>(
                fetchImpl,
                resolveEndpoint(opts.url, "validate-action"),
                {
                    ...request,
                    parameters: encode({
                        ir: ontology,
                        target: { kind: "actionParameters", actionType: request.actionType },
                        value: request.parameters,
                    }) as Record<string, unknown>,
                },
                getHeaders(),
                options
            );
        },
        resolveActionParameters: async (request, options) => {
            if (actionParameterResolutionSupported === false) {
                throw new Error("Remote ontology server does not support action parameter resolution.");
            }
            const ontology = getIr();
            const response = await postJson<RemoteResolveActionParametersResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "resolve-action-parameters"),
                {
                    ...request,
                    parameters: encode({
                        ir: ontology,
                        target: { kind: "actionParameters", actionType: request.actionType },
                        value: request.parameters,
                    }) as Record<string, unknown>,
                },
                getHeaders(),
                options
            );
            return {
                parameters: decode({
                    ir: ontology,
                    target: { kind: "actionParameters", actionType: request.actionType },
                    value: response.parameters,
                }) as Record<string, unknown>,
            };
        },
        runQueryFunction: async (request, options) => {
            const ontology = getIr();
            const response = await postJson<RemoteRunQueryFunctionResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "run-query-function"),
                {
                    ...request,
                    parameters: encode({
                        ir: ontology,
                        target: {
                            kind: "queryFunctionParameters",
                            queryFunctionType: request.queryFunctionType,
                        },
                        value: request.parameters,
                    }) as Record<string, unknown>,
                },
                getHeaders(),
                options
            );
            return {
                ...response,
                value: decode({
                    ir: ontology,
                    target: { kind: "queryFunctionReturn", queryFunctionType: request.queryFunctionType },
                    value: response.value,
                }),
            };
        },
        getAttachmentMetadata: (request: RemoteAttachmentMetadataRequest, options) =>
            postJson<PartialAttachmentMetadata>(
                fetchImpl,
                resolveEndpoint(opts.url, "attachment-metadata"),
                request,
                getHeaders(),
                options
            ),
        getAttachmentContent: (request: RemoteAttachmentRequest, options) =>
            postBlob(
                fetchImpl,
                resolveEndpoint(opts.url, "attachment-content"),
                request,
                getHeaders(),
                options
            ),
    };
}

export function createInProcessHttpRemoteOntologyTransport(
    server: RemoteOntologyServer,
    opts: InProcessHttpRemoteOntologyTransportOptions = {}
): ResolvableRemoteOntologyTransport {
    return createHttpRemoteOntologyTransport({
        ...opts,
        url: "http://remote-ontology.in-process/",
        fetch: (input, init) => server.handleRequest(new Request(input, init)),
    });
}
