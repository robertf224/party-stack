import type {
    RemoteApplyActionResponse,
    RemoteAttachmentMetadataRequest,
    RemoteAttachmentRequest,
    RemoteRunQueryFunctionResponse,
    RemoteLoadSubsetResponse,
    RemoteOntologyDescription,
    RemoteOntologyTransport,
    RemoteOntologyTransportOptions,
} from "./protocol.js";
import type {
    OntologyIR,
    PartialAttachmentMetadata,
    Uncertain,
} from "@party-stack/ontology";
import type { Result } from "@party-stack/ontology/values";
import { decode, encode } from "@party-stack/ontology/json";
import { parseRemoteOntologyErrorBody } from "./errors.js";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";

export interface HttpRemoteOntologyTransportOptions {
    url: string | URL;
    ir?: OntologyIR;
    fetch?: typeof fetch;
    headers?: HeadersInit | (() => HeadersInit);
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
    const response = await fetchImpl(url, {
        method: "POST",
        headers: {
            ...headers,
            "content-type": "application/json",
        },
        body: serializeRemoteOntologyJson(body),
        signal: options?.signal,
    });

    await throwIfNotOk(response);
    return parseRemoteOntologyJson(await response.text()) as TResponse;
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
        formData.append(
            `attachment:${upload.attachment.id}`,
            upload.blob,
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
    const response = await fetchImpl(url, {
        method: "POST",
        headers: {
            ...headers,
            "content-type": "application/json",
        },
        body: serializeRemoteOntologyJson(body),
        signal: options?.signal,
    });

    await throwIfNotOk(response);
    return response.blob();
}

export function createHttpRemoteOntologyTransport(
    opts: HttpRemoteOntologyTransportOptions
): RemoteOntologyTransport {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const getHeaders = () => (typeof opts.headers === "function" ? opts.headers() : opts.headers);
    let ir = opts.ir;
    let actionValidationSupported: boolean | undefined;
    const getIr = () => {
        if (!ir) {
            throw new Error(
                "HTTP remote ontology transport must describe the ontology before typed requests."
            );
        }
        return ir;
    };

    return {
        describe: async (options) => {
            const description = await postJson<RemoteOntologyDescription>(
                fetchImpl,
                resolveEndpoint(opts.url, "describe"),
                {},
                getHeaders(),
                options
            );
            ir = description.ir;
            actionValidationSupported =
                description.capabilities?.actionValidation === true;
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
            return postJson<Uncertain<Result<null, string[]>>>(
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
