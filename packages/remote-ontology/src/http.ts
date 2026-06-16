import type {
    RemoteApplyActionResponse,
    RemoteAttachmentRequest,
    RemoteRunQueryResponse,
    RemoteLoadSubsetResponse,
    RemoteOntologyDescription,
    RemoteOntologyTransport,
    RemoteOntologyTransportOptions,
} from "./protocol.js";
import type { OntologyIR, TypeDef } from "@party-stack/ontology";
import {
    hydrateOntologyJsonObject,
    hydrateOntologyJsonValue,
    serializeOntologyJsonValue,
} from "@party-stack/ontology/utils";
import type { attachment } from "@party-stack/ontology/values";
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

function getActionType(ir: OntologyIR, actionType: string): OntologyIR["actionTypes"][number] {
    const actionTypeDef = ir.actionTypes.find((candidate) => candidate.name === actionType);
    if (!actionTypeDef) {
        throw new Error(`Unknown ontology action type "${actionType}".`);
    }
    return actionTypeDef;
}

function getQueryType(ir: OntologyIR, queryType: string): OntologyIR["queryTypes"][number] {
    const queryTypeDef = ir.queryTypes.find((candidate) => candidate.name === queryType);
    if (!queryTypeDef) {
        throw new Error(`Unknown ontology query type "${queryType}".`);
    }
    return queryTypeDef;
}

function serializeParameters(
    ir: OntologyIR,
    parameterTypes: Map<string, TypeDef>,
    parameters: Record<string, unknown>
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(parameters).map(([parameterName, value]) => {
            const parameterType = parameterTypes.get(parameterName);
            return [
                parameterName,
                parameterType ? serializeOntologyJsonValue(ir, parameterType, value) : value,
            ];
        })
    );
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
    let ir = opts.ir;
    const getIr = () => {
        if (!ir) {
            throw new Error("HTTP remote ontology transport must describe the ontology before typed requests.");
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
                objects: response.objects.map((object) =>
                    hydrateOntologyJsonObject({
                        ir: getIr(),
                        objectTypeName: response.objectType,
                        object,
                    })
                ),
            };
        },
        applyAction: (request, options) => {
            const ontology = getIr();
            const actionTypeDef = getActionType(ontology, request.actionType);
            const parameterTypes = new Map(actionTypeDef.parameters.map((parameter) => [parameter.name, parameter.type]));
            const body = {
                ...request,
                parameters: serializeParameters(ontology, parameterTypes, request.parameters),
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
        runQuery: async (request, options) => {
            const ontology = getIr();
            const queryTypeDef = getQueryType(ontology, request.queryType);
            const parameterTypes = new Map(queryTypeDef.parameters.map((parameter) => [parameter.name, parameter.type]));
            const response = await postJson<RemoteRunQueryResponse>(
                fetchImpl,
                resolveEndpoint(opts.url, "run-query"),
                {
                    ...request,
                    parameters: serializeParameters(ontology, parameterTypes, request.parameters),
                },
                getHeaders(),
                options
            );
            return {
                ...response,
                value: hydrateOntologyJsonValue(ontology, queryTypeDef.returnType, response.value),
            };
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
