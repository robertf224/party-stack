import type {
    RemoteApplyActionResponse,
    RemoteLoadSubsetResponse,
    RemoteOntologyDescription,
    RemoteOntologyTransport,
    RemoteOntologyTransportOptions,
} from "./protocol.js";
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
        applyAction: (request, options) =>
            postJson<RemoteApplyActionResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "apply-action"),
                request,
                getHeaders(),
                options
            ),
    };
}
