import type {
    RemoteApplyActionResponse,
    RemoteAttachmentRequest,
    RemoteLoadSubsetResponse,
    RemoteOntologyDescription,
    RemoteOntologyTransport,
    RemoteOntologyTransportOptions,
} from "./protocol.js";
import type { attachment } from "@party-stack/ontology/values";
import { parseRemoteOntologyJson, serializeRemoteOntologyJson } from "./protocol.js";

export interface HttpRemoteOntologyTransportOptions {
    url: string | URL;
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

    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Remote ontology request failed with status ${response.status}.`);
    }

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
            upload.attachment.name ?? upload.attachment.id
        );
    }

    const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: formData,
        signal: options?.signal,
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Remote ontology request failed with status ${response.status}.`);
    }

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

    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Remote ontology request failed with status ${response.status}.`);
    }

    return response.blob();
}

export function createHttpRemoteOntologyTransport(
    opts: HttpRemoteOntologyTransportOptions
): RemoteOntologyTransport {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const getHeaders = () => (typeof opts.headers === "function" ? opts.headers() : opts.headers);
    return {
        describe: (options) =>
            postJson<RemoteOntologyDescription>(
                fetchImpl,
                resolveEndpoint(opts.url, "describe"),
                {},
                getHeaders(),
                options
            ),
        loadSubset: (request, options) =>
            postJson<RemoteLoadSubsetResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "load-subset"),
                request,
                getHeaders(),
                options
            ),
        applyAction: (request, options) => {
            const hasAttachments = options?.attachments && options.attachments.length > 0;
            return hasAttachments
                ? postMultipart<RemoteApplyActionResponse>(
                      fetchImpl,
                      resolveEndpoint(opts.url, "apply-action"),
                      request,
                      getHeaders(),
                      options
                  )
                : postJson<RemoteApplyActionResponse>(
                      fetchImpl,
                      resolveEndpoint(opts.url, "apply-action"),
                      request,
                      getHeaders(),
                      options
                  );
        },
        getAttachmentMetadata: (request: RemoteAttachmentRequest, options) =>
            postJson<attachment & { size: number; type: string; name: string }>(
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
