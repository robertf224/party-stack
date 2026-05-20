import { z } from "zod";
import type { LoadSubsetOptions } from "@tanstack/db";
import type { OntologyIR } from "@party-stack/ontology";

export interface RemoteOntologyDescription {
    ir: OntologyIR;
    version: string;
}

export type RemoteOntologyEndpoint = "describe" | "load-subset" | "apply-action";

export interface RemoteDescribeRequest {
    ontologyVersion?: string;
}

export type RemoteLoadSubsetOptions = Omit<LoadSubsetOptions, "subscription">;

export interface RemoteLoadSubsetRequest {
    objectType: string;
    options?: RemoteLoadSubsetOptions;
    ontologyVersion?: string;
}

export interface RemoteLoadSubsetResponse {
    objectType: string;
    objects: Record<string, unknown>[];
    version: string;
}

export interface RemoteApplyActionRequest {
    actionType: string;
    parameters: Record<string, unknown>;
    ontologyVersion?: string;
}

export interface RemoteApplyActionResponse {
    version: string;
    invalidatedObjectTypes?: string[];
}

export interface RemoteOntologyTransport {
    describe: () => Promise<RemoteOntologyDescription>;
    loadSubset: (request: RemoteLoadSubsetRequest) => Promise<RemoteLoadSubsetResponse>;
    applyAction: (request: RemoteApplyActionRequest) => Promise<RemoteApplyActionResponse>;
}

export type RemoteOntologyRequestByEndpoint = {
    describe: RemoteDescribeRequest;
    "load-subset": RemoteLoadSubsetRequest;
    "apply-action": RemoteApplyActionRequest;
};

export type RemoteOntologyResponseByEndpoint = {
    describe: RemoteOntologyDescription;
    "load-subset": RemoteLoadSubsetResponse;
    "apply-action": RemoteApplyActionResponse;
};

export type RemoteOntologyRequestEnvelope =
    | { endpoint: "describe"; input: RemoteDescribeRequest }
    | { endpoint: "load-subset"; input: RemoteLoadSubsetRequest }
    | { endpoint: "apply-action"; input: RemoteApplyActionRequest };

const recordSchema = z.record(z.string(), z.unknown());

export const remoteOntologyEndpointSchema = z.enum(["describe", "load-subset", "apply-action"]);

export const remoteLoadSubsetOptionsSchema = recordSchema as z.ZodType<RemoteLoadSubsetOptions>;

export const remoteDescribeRequestSchema = z
    .object({
        ontologyVersion: z.string().optional(),
    })
    .strict() satisfies z.ZodType<RemoteDescribeRequest>;

export const remoteLoadSubsetRequestSchema = z
    .object({
        objectType: z.string().min(1),
        options: remoteLoadSubsetOptionsSchema.optional(),
        ontologyVersion: z.string().optional(),
    })
    .strict() satisfies z.ZodType<RemoteLoadSubsetRequest>;

export const remoteApplyActionRequestSchema = z
    .object({
        actionType: z.string().min(1),
        parameters: recordSchema,
        ontologyVersion: z.string().optional(),
    })
    .strict() satisfies z.ZodType<RemoteApplyActionRequest>;

export const remoteOntologyRpc = {
    describe: {
        endpoint: "describe",
        schema: remoteDescribeRequestSchema,
    },
    loadSubset: {
        endpoint: "load-subset",
        schema: remoteLoadSubsetRequestSchema,
    },
    applyAction: {
        endpoint: "apply-action",
        schema: remoteApplyActionRequestSchema,
    },
} as const;

export function parseRemoteOntologyRequest(
    endpoint: RemoteOntologyEndpoint,
    input: unknown
): RemoteOntologyRequestEnvelope {
    switch (endpoint) {
        case "describe":
            return { endpoint, input: remoteOntologyRpc.describe.schema.parse(input) };
        case "load-subset":
            return { endpoint, input: remoteOntologyRpc.loadSubset.schema.parse(input) };
        case "apply-action":
            return { endpoint, input: remoteOntologyRpc.applyAction.schema.parse(input) };
    }
}

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
    headers?: HeadersInit
): Promise<TResponse> {
    const response = await fetchImpl(url, {
        method: "POST",
        headers: {
            ...headers,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Remote ontology request failed with status ${response.status}.`);
    }

    return (await response.json()) as TResponse;
}

export function createHttpRemoteOntologyTransport(
    opts: HttpRemoteOntologyTransportOptions
): RemoteOntologyTransport {
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const getHeaders = () => (typeof opts.headers === "function" ? opts.headers() : opts.headers);
    return {
        describe: () =>
            postJson<RemoteOntologyDescription>(
                fetchImpl,
                resolveEndpoint(opts.url, "describe"),
                {},
                getHeaders()
            ),
        loadSubset: (request) =>
            postJson<RemoteLoadSubsetResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "load-subset"),
                request,
                getHeaders()
            ),
        applyAction: (request) =>
            postJson<RemoteApplyActionResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "apply-action"),
                request,
                getHeaders()
            ),
    };
}

export function serializeLoadSubsetOptions(options: LoadSubsetOptions | undefined): RemoteLoadSubsetOptions {
    if (!options) return {};
    const { subscription: _subscription, ...serializableOptions } = options;
    return serializableOptions;
}
