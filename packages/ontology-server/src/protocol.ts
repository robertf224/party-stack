import { z } from "zod";
import type {
    OntologyAttachmentIdMapping,
    OntologyAttachmentUpload,
    OntologyIR,
    PartialAttachmentMetadata,
    Uncertain,
    ValidationIssue,
} from "@party-stack/ontology";
import type { BackendSnapshot, BackendChangePage } from "@party-stack/ontology-backend";
import type { Result } from "@party-stack/ontology/values";
import type { attachment } from "@party-stack/ontology/values";
import type { LoadSubsetOptions } from "@tanstack/db";

export interface RemoteOntologyDescription {
    ir: OntologyIR;
    context?: Record<string, unknown>;
    capabilities?: {
        actionValidation?: boolean;
        actionParameterResolution?: boolean;
        journal?: boolean;
    };
}

export type RemoteOntologyEndpoint =
    | "decrypt"
    | "describe"
    | "replica-snapshot"
    | "pull-changes"
    | "load-subset"
    | "validate-action"
    | "resolve-action-parameters"
    | "apply-action"
    | "run-query-function"
    | "attachment-metadata"
    | "attachment-content";

export interface RemoteReplicaSnapshotRequest {
    objectType: string;
}
export interface RemotePullChangesRequest {
    cursor?: string;
    limit?: number;
}

export type RemoteDescribeRequest = Record<string, never>;

export type RemoteLoadSubsetOptions = Omit<LoadSubsetOptions, "signal" | "subscription">;

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
    idempotencyKey?: string;
    replay?: { now: string; seed: string };
}

export interface RemoteApplyActionResponse {
    receipt?: import("@party-stack/ontology-backend").ActionReceipt;
    invalidatedObjectTypes?: string[];
    attachmentIdMappings?: OntologyAttachmentIdMapping[];
}

export interface RemoteValidateActionRequest {
    actionType: string;
    parameters: Record<string, unknown>;
}

export interface RemoteResolveActionParametersRequest {
    actionType: string;
    parameters: Record<string, unknown>;
}

export interface RemoteResolveActionParametersResponse {
    parameters: Record<string, unknown>;
}

export interface RemoteRunQueryFunctionRequest {
    queryFunctionType: string;
    parameters: Record<string, unknown>;
}

export interface RemoteRunQueryFunctionResponse {
    value: unknown;
}

export interface RemoteDecryptRequest {
    value: import("@party-stack/ontology/values").Encrypted;
}

export interface RemoteAttachmentRequest {
    attachment: attachment;
}

export interface RemoteAttachmentMetadataRequest extends RemoteAttachmentRequest {
    selection: ReadonlyArray<keyof PartialAttachmentMetadata>;
}

export interface RemoteOntologyTransportOptions {
    signal?: AbortSignal;
    attachments?: OntologyAttachmentUpload[];
}

export interface RemoteOntologyTransport {
    readonly sourceId?: string;
    decrypt?: (
        request: RemoteDecryptRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<import("@party-stack/ontology-backend").DecryptedValue>;
    /** Explicitly authorized full replica feed; ordinary row policies do not grant this capability. */
    replicaSnapshot?: (
        request: RemoteReplicaSnapshotRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<BackendSnapshot>;
    pullChanges?: (
        request: RemotePullChangesRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<BackendChangePage>;
    describe: (options?: RemoteOntologyTransportOptions) => Promise<RemoteOntologyDescription>;
    loadSubset: (
        request: RemoteLoadSubsetRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteLoadSubsetResponse>;
    applyAction: (
        request: RemoteApplyActionRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteApplyActionResponse>;
    validateAction: (
        request: RemoteValidateActionRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<Uncertain<Result<null, readonly ValidationIssue[]>>>;
    resolveActionParameters?: (
        request: RemoteResolveActionParametersRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteResolveActionParametersResponse>;
    runQueryFunction: (
        request: RemoteRunQueryFunctionRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteRunQueryFunctionResponse>;
    getAttachmentMetadata: (
        request: RemoteAttachmentMetadataRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<PartialAttachmentMetadata>;
    getAttachmentContent: (
        request: RemoteAttachmentRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<Blob>;
}

export interface ResolvableRemoteOntologyTransport extends RemoteOntologyTransport {
    resolveActionParameters: (
        request: RemoteResolveActionParametersRequest,
        options?: RemoteOntologyTransportOptions
    ) => Promise<RemoteResolveActionParametersResponse>;
}

export type RemoteOntologyRequestByEndpoint = {
    decrypt: RemoteDecryptRequest;
    describe: RemoteDescribeRequest;
    "replica-snapshot": RemoteReplicaSnapshotRequest;
    "pull-changes": RemotePullChangesRequest;
    "load-subset": RemoteLoadSubsetRequest;
    "validate-action": RemoteValidateActionRequest;
    "resolve-action-parameters": RemoteResolveActionParametersRequest;
    "apply-action": RemoteApplyActionRequest;
    "run-query-function": RemoteRunQueryFunctionRequest;
    "attachment-metadata": RemoteAttachmentMetadataRequest;
    "attachment-content": RemoteAttachmentRequest;
};

export type RemoteOntologyResponseByEndpoint = {
    decrypt: import("@party-stack/ontology-backend").DecryptedValue;
    describe: RemoteOntologyDescription;
    "replica-snapshot": BackendSnapshot;
    "pull-changes": BackendChangePage;
    "load-subset": RemoteLoadSubsetResponse;
    "validate-action": Uncertain<Result<null, readonly ValidationIssue[]>>;
    "resolve-action-parameters": RemoteResolveActionParametersResponse;
    "apply-action": RemoteApplyActionResponse;
    "run-query-function": RemoteRunQueryFunctionResponse;
    "attachment-metadata": PartialAttachmentMetadata;
    "attachment-content": Blob;
};

export type RemoteOntologyRequestEnvelope =
    | { endpoint: "decrypt"; input: RemoteDecryptRequest }
    | { endpoint: "describe"; input: RemoteDescribeRequest }
    | { endpoint: "replica-snapshot"; input: RemoteReplicaSnapshotRequest }
    | { endpoint: "pull-changes"; input: RemotePullChangesRequest }
    | { endpoint: "load-subset"; input: RemoteLoadSubsetRequest }
    | { endpoint: "validate-action"; input: RemoteValidateActionRequest }
    | { endpoint: "resolve-action-parameters"; input: RemoteResolveActionParametersRequest }
    | { endpoint: "apply-action"; input: RemoteApplyActionRequest }
    | { endpoint: "run-query-function"; input: RemoteRunQueryFunctionRequest }
    | { endpoint: "attachment-metadata"; input: RemoteAttachmentMetadataRequest }
    | { endpoint: "attachment-content"; input: RemoteAttachmentRequest };

const recordSchema = z.record(z.string(), z.unknown());

export function serializeRemoteOntologyJson(value: unknown): string {
    return JSON.stringify(value);
}

export function parseRemoteOntologyJson(text: string): unknown {
    return JSON.parse(text);
}

export const remoteOntologyEndpointSchema = z.enum([
    "decrypt",
    "describe",
    "replica-snapshot",
    "pull-changes",
    "load-subset",
    "validate-action",
    "resolve-action-parameters",
    "apply-action",
    "run-query-function",
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
        idempotencyKey: z.string().min(1).optional(),
        replay: z.object({ now: z.string(), seed: z.string().min(1) }).optional(),
    })
    .strict() satisfies z.ZodType<RemoteApplyActionRequest>;

export const remoteValidateActionRequestSchema = z
    .object({
        actionType: z.string().min(1),
        parameters: recordSchema,
    })
    .strict() satisfies z.ZodType<RemoteValidateActionRequest>;

export const remoteResolveActionParametersRequestSchema = z
    .object({
        actionType: z.string().min(1),
        parameters: recordSchema,
    })
    .strict() satisfies z.ZodType<RemoteResolveActionParametersRequest>;

export const remoteRunQueryFunctionRequestSchema = z
    .object({
        queryFunctionType: z.string().min(1),
        parameters: recordSchema,
    })
    .strict() satisfies z.ZodType<RemoteRunQueryFunctionRequest>;

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
        type: z.string().optional(),
        source: attachmentSourceSchema.optional(),
    })
    .strict() satisfies z.ZodType<attachment>;

export const remoteAttachmentRequestSchema = z
    .object({
        attachment: remoteAttachmentSchema,
    })
    .strict() satisfies z.ZodType<RemoteAttachmentRequest>;

export const remoteAttachmentMetadataRequestSchema = z
    .object({
        attachment: remoteAttachmentSchema,
        selection: z.array(z.enum(["size", "type", "name", "dimensions"])),
    })
    .strict() satisfies z.ZodType<RemoteAttachmentMetadataRequest>;

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
    validateAction: {
        endpoint: "validate-action",
        schema: remoteValidateActionRequestSchema,
    },
    resolveActionParameters: {
        endpoint: "resolve-action-parameters",
        schema: remoteResolveActionParametersRequestSchema,
    },
    runQueryFunction: {
        endpoint: "run-query-function",
        schema: remoteRunQueryFunctionRequestSchema,
    },
    attachmentMetadata: {
        endpoint: "attachment-metadata",
        schema: remoteAttachmentMetadataRequestSchema,
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
        case "decrypt":
            return {
                endpoint,
                input: z
                    .object({
                        value: z
                            .object({
                                ciphertext: z.string().min(1),
                                source: attachmentSourceSchema.optional(),
                            })
                            .strict(),
                    })
                    .strict()
                    .parse(input),
            };
        case "replica-snapshot":
            return {
                endpoint,
                input: z
                    .object({ objectType: z.string().min(1) })
                    .strict()
                    .parse(input),
            };
        case "pull-changes":
            return {
                endpoint,
                input: z
                    .object({
                        cursor: z.string().min(1).optional(),
                        limit: z.number().int().min(1).max(1000).optional(),
                    })
                    .strict()
                    .parse(input),
            };
        case "describe":
            return { endpoint, input: remoteOntologyRpc.describe.schema.parse(input) };
        case "load-subset":
            return { endpoint, input: remoteOntologyRpc.loadSubset.schema.parse(input) };
        case "validate-action":
            return { endpoint, input: remoteOntologyRpc.validateAction.schema.parse(input) };
        case "resolve-action-parameters":
            return { endpoint, input: remoteOntologyRpc.resolveActionParameters.schema.parse(input) };
        case "apply-action":
            return { endpoint, input: remoteOntologyRpc.applyAction.schema.parse(input) };
        case "run-query-function":
            return { endpoint, input: remoteOntologyRpc.runQueryFunction.schema.parse(input) };
        case "attachment-metadata":
            return { endpoint, input: remoteOntologyRpc.attachmentMetadata.schema.parse(input) };
        case "attachment-content":
            return { endpoint, input: remoteOntologyRpc.attachmentContent.schema.parse(input) };
    }
}

export function serializeLoadSubsetOptions(options: LoadSubsetOptions | undefined): RemoteLoadSubsetOptions {
    if (!options) return {};
    const { signal: _signal, subscription: _subscription, ...serializableOptions } = options;
    return serializableOptions;
}
