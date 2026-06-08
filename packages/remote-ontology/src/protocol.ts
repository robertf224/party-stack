import { z } from "zod";
import { Temporal } from "temporal-polyfill";
import type { LoadSubsetOptions } from "@tanstack/db";
import type { OntologyIR } from "@party-stack/ontology";
import type { attachment } from "@party-stack/ontology/values";

export interface RemoteOntologyDescription {
    ir: OntologyIR;
    context?: Record<string, unknown>;
}

export type RemoteOntologyEndpoint =
    | "describe"
    | "load-subset"
    | "apply-action"
    | "attachment-metadata"
    | "attachment-content";

export type RemoteDescribeRequest = Record<string, never>;

export type RemoteLoadSubsetOptions = Omit<LoadSubsetOptions, "subscription">;

export interface RemoteLoadSubsetRequest {
    objectType: string;
    options?: RemoteLoadSubsetOptions;
}

export interface RemoteLoadSubsetResponse {
    objectType: string;
    objects: Record<string, unknown>[];
}

export interface RemoteApplyActionRequest {
    actionType: string;
    parameters: Record<string, unknown>;
}

export interface RemoteApplyActionResponse {
    invalidatedObjectTypes?: string[];
}

export interface RemoteAttachmentRequest {
    attachment: attachment;
}

export interface RemoteAttachmentUpload {
    attachment: attachment;
    blob: Blob;
}

export interface RemoteOntologyTransportOptions {
    signal?: AbortSignal;
    attachments?: RemoteAttachmentUpload[];
}

export interface RemoteOntologyTransport {
    describe: (options?: RemoteOntologyTransportOptions) => Promise<RemoteOntologyDescription>;
    loadSubset: (
        request: RemoteLoadSubsetRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteLoadSubsetResponse>;
    applyAction: (
        request: RemoteApplyActionRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteApplyActionResponse>;
    getAttachmentMetadata: (
        request: RemoteAttachmentRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<attachment & { size: number; type: string; name: string }>;
    getAttachmentContent: (
        request: RemoteAttachmentRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<Blob>;
}

export type RemoteOntologyRequestByEndpoint = {
    describe: RemoteDescribeRequest;
    "load-subset": RemoteLoadSubsetRequest;
    "apply-action": RemoteApplyActionRequest;
    "attachment-metadata": RemoteAttachmentRequest;
    "attachment-content": RemoteAttachmentRequest;
};

export type RemoteOntologyResponseByEndpoint = {
    describe: RemoteOntologyDescription;
    "load-subset": RemoteLoadSubsetResponse;
    "apply-action": RemoteApplyActionResponse;
    "attachment-metadata": attachment & { size: number; type: string; name: string };
    "attachment-content": Blob;
};

export type RemoteOntologyRequestEnvelope =
    | { endpoint: "describe"; input: RemoteDescribeRequest }
    | { endpoint: "load-subset"; input: RemoteLoadSubsetRequest }
    | { endpoint: "apply-action"; input: RemoteApplyActionRequest }
    | { endpoint: "attachment-metadata"; input: RemoteAttachmentRequest }
    | { endpoint: "attachment-content"; input: RemoteAttachmentRequest };

const recordSchema = z.record(z.string(), z.unknown());
const remoteJsonTypeKey = "$partyStackRemoteOntologyType";

type RemoteJsonEncodedValue = {
    [remoteJsonTypeKey]: "Temporal.Instant" | "Temporal.PlainDate";
    value: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function encodeRemoteJsonValue(value: unknown, seen: WeakSet<object>): unknown {
    if (value instanceof Temporal.Instant) {
        return {
            [remoteJsonTypeKey]: "Temporal.Instant",
            value: value.toString(),
        } satisfies RemoteJsonEncodedValue;
    }
    if (value instanceof Temporal.PlainDate) {
        return {
            [remoteJsonTypeKey]: "Temporal.PlainDate",
            value: value.toString(),
        } satisfies RemoteJsonEncodedValue;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new TypeError("Cannot serialize circular remote ontology payload.");
        seen.add(value);
        const encoded = value.map((item) => encodeRemoteJsonValue(item, seen));
        seen.delete(value);
        return encoded;
    }
    if (isRecord(value)) {
        if (seen.has(value)) throw new TypeError("Cannot serialize circular remote ontology payload.");
        seen.add(value);
        const encoded = Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, encodeRemoteJsonValue(entry, seen)])
        );
        seen.delete(value);
        return encoded;
    }
    return value;
}

function isRemoteJsonEncodedValue(value: unknown): value is RemoteJsonEncodedValue {
    return (
        isRecord(value) &&
        typeof value[remoteJsonTypeKey] === "string" &&
        typeof value.value === "string"
    );
}

function decodeRemoteJsonValue(_key: string, value: unknown): unknown {
    if (!isRemoteJsonEncodedValue(value)) return value;

    switch (value[remoteJsonTypeKey]) {
        case "Temporal.Instant":
            return Temporal.Instant.from(value.value);
        case "Temporal.PlainDate":
            return Temporal.PlainDate.from(value.value);
        default:
            return value;
    }
}

export function serializeRemoteOntologyJson(value: unknown): string {
    return JSON.stringify(encodeRemoteJsonValue(value, new WeakSet()));
}

export function parseRemoteOntologyJson(text: string): unknown {
    return JSON.parse(text, decodeRemoteJsonValue);
}

export const remoteOntologyEndpointSchema = z.enum([
    "describe",
    "load-subset",
    "apply-action",
    "attachment-metadata",
    "attachment-content",
]);

export const remoteLoadSubsetOptionsSchema = recordSchema as z.ZodType<RemoteLoadSubsetOptions>;

export const remoteDescribeRequestSchema = z.object({}).strict() satisfies z.ZodType<RemoteDescribeRequest>;

export const remoteLoadSubsetRequestSchema = z
    .object({
        objectType: z.string().min(1),
        options: remoteLoadSubsetOptionsSchema.optional(),
    })
    .strict() satisfies z.ZodType<RemoteLoadSubsetRequest>;

export const remoteApplyActionRequestSchema = z
    .object({
        actionType: z.string().min(1),
        parameters: recordSchema,
    })
    .strict() satisfies z.ZodType<RemoteApplyActionRequest>;

const attachmentSourceSchema = z
    .object({
        objectType: z.string().min(1),
        primaryKey: z.union([z.string(), z.number()]),
        property: z.string().min(1),
    })
    .strict();

export const remoteAttachmentSchema = z
    .object({
        id: z.string().min(1),
        size: z.number().optional(),
        type: z.string().optional(),
        name: z.string().optional(),
        source: attachmentSourceSchema.optional(),
    })
    .strict() satisfies z.ZodType<attachment>;

export const remoteAttachmentRequestSchema = z
    .object({
        attachment: remoteAttachmentSchema,
    })
    .strict() satisfies z.ZodType<RemoteAttachmentRequest>;

const remoteOntologyRpc = {
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
    attachmentMetadata: {
        endpoint: "attachment-metadata",
        schema: remoteAttachmentRequestSchema,
    },
    attachmentContent: {
        endpoint: "attachment-content",
        schema: remoteAttachmentRequestSchema,
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
        case "attachment-metadata":
            return { endpoint, input: remoteOntologyRpc.attachmentMetadata.schema.parse(input) };
        case "attachment-content":
            return { endpoint, input: remoteOntologyRpc.attachmentContent.schema.parse(input) };
    }
}

export function serializeLoadSubsetOptions(options: LoadSubsetOptions | undefined): RemoteLoadSubsetOptions {
    if (!options) return {};
    const { subscription: _subscription, ...serializableOptions } = options;
    return serializableOptions;
}
