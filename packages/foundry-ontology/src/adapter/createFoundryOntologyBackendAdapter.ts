import { invariant } from "@bobbyfidz/panic";
import { MediaSets } from "@osdk/foundry.mediasets";
import {
    Actions,
    AttachmentRid,
    Attachments,
    MediaReferenceProperties,
    Queries,
} from "@osdk/foundry.ontologies";
import {
    certain,
    NonRetryableError,
    uncertain,
    type PartialAttachmentMetadata,
    type OntologyAttachmentIdMapping,
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyAttachmentsAdapter,
    type OntologyIR,
    type ValidateActionDraftLiveOpts,
} from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { resolveType, unwrapType } from "@party-stack/ontology/utils";
import { Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { getFoundryAttachmentKind } from "../meta/foundryAttachmentMetadata.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { makeFoundryBackend } from "./backend.js";
import {
    getFoundryValidationIssues,
    loadFoundrySubmissionCriteria,
    validateFoundryActionDraftCriteria,
} from "./foundryActionValidation.js";
import { createFoundryCodec } from "./foundryCodec.js";
import { decodeFoundryMediaId, mediaReferenceToFoundryMediaId } from "./foundryMediaId.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type { BackendSnapshot } from "@party-stack/ontology-backend";
import type { Query } from "@party-stack/ontology-storage";
import type { attachment } from "@party-stack/ontology/values";

function isFoundryAttachmentRid(value: string): value is AttachmentRid {
    return /^ri\.attachments\.[^.]+\.attachment\..+$/.test(value);
}

export function isFoundryNotFoundError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const foundryError = error as {
        statusCode?: unknown;
        errorCode?: unknown;
    };
    return foundryError.statusCode === 404 || foundryError.errorCode === "NOT_FOUND";
}

export interface FoundryUsersIntegration {
    objectType: string;
    loadSubset(client: OntologyClient, query: Query, signal: AbortSignal): Promise<BackendSnapshot>;
    getAttachmentContent?(client: OntologyClient, attachment: attachment): Promise<Blob | undefined>;
    getAttachmentMetadata?(
        client: OntologyClient,
        attachment: attachment,
        selection: readonly (keyof PartialAttachmentMetadata)[]
    ): Promise<PartialAttachmentMetadata | undefined>;
}

type ApplyActionResult = Awaited<ReturnType<typeof Actions.applyWithOverrides>> & {
    operationId?: string;
};

function serializeOverrideValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Temporal.Instant) {
        return value.toString();
    }
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime) {
        return value.toString();
    }
    return JSON.stringify(value) ?? "";
}

function serializeActionExecutionTime(value: unknown): string {
    try {
        const candidate = value instanceof Date ? value.toISOString() : String(value);
        return Temporal.Instant.from(candidate).toString();
    } catch (cause) {
        throw new TypeError("Invalid action execution time: expected a Date or Temporal-like ISO instant.", {
            cause,
        });
    }
}

function getAttachmentName(attachment: unknown): string | undefined {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
        return undefined;
    }
    const name = (attachment as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
}

function getAttachmentProviderType(
    target: { meta?: Record<string, unknown> } | undefined
): "attachment" | "media" {
    return getFoundryAttachmentKind(target?.meta);
}

function prepareFoundryActionInvocation(options: {
    ir: OntologyIR;
    name: string;
    parameters: Record<string, unknown>;
    codec: ReturnType<typeof createFoundryCodec>;
}): {
    parameters: Record<string, unknown>;
    overrides: {
        uniqueIdentifierLinkIdValues: Record<string, string>;
        actionExecutionTime?: string;
    };
} {
    const actionType = options.ir.actionTypes.find((candidate) => candidate.name === options.name);
    if (!actionType) {
        throw new NonRetryableError(`Unknown Foundry action type "${options.name}".`);
    }
    const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
    const parameterTypes = new Map(
        actionType.parameters.map((parameter) => [parameter.name, parameter.type])
    );
    const parameters: Record<string, unknown> = {};
    const uniqueIdentifierLinkIdValues: Record<string, string> = {};
    let actionExecutionTime: string | undefined;

    for (const [parameterName, value] of Object.entries(options.parameters)) {
        if (overrideMapping.uuidByParameterName.has(parameterName)) {
            if (value !== undefined) {
                uniqueIdentifierLinkIdValues[overrideMapping.uuidByParameterName.get(parameterName)!] =
                    serializeOverrideValue(value);
            }
            continue;
        }
        if (overrideMapping.nowParameterName === parameterName) {
            if (value !== undefined) {
                actionExecutionTime = serializeActionExecutionTime(value);
            }
            continue;
        }
        if (value !== undefined) {
            const parameterType = parameterTypes.get(parameterName);
            parameters[parameterName] = parameterType
                ? options.codec.encodeValue(parameterType, value)
                : value;
        }
    }

    return {
        parameters,
        overrides: {
            uniqueIdentifierLinkIdValues,
            actionExecutionTime,
        },
    };
}

export interface CreateFoundryOntologyBackendAdapterOptions {
    client: OntologyClient;
    ir: OntologyIR;
    users?: FoundryUsersIntegration;
    live?: boolean;
}

function withRequestSignal(client: OntologyClient, signal?: AbortSignal): OntologyClient {
    return signal
        ? {
              ...client,
              fetch: (input, init) =>
                  client.fetch(input, {
                      ...init,
                      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
                  }),
          }
        : client;
}

export function createFoundryOntologyBackendAdapter(
    opts: CreateFoundryOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    const codec = createFoundryCodec(opts.ir);
    const attachments: OntologyAttachmentsAdapter = {
        generateAttachmentId: (_, { target }) => {
            invariant(
                target,
                "A property target must be passed to generateAttachmentId in the Foundry adapter so that we know whether to target attachments or media."
            );
            if (getFoundryAttachmentKind(target.meta) === "attachment") {
                return `ri.attachments.main.attachment.${crypto.randomUUID()}`;
            }
            return crypto.randomUUID();
        },
        canMaterializeAttachment: (_, { target }) => getAttachmentProviderType(target) !== "media",
        materializeAttachment: async (attachment, blob, { target }) => {
            invariant(
                target,
                "A property target must be passed to materializeAttachment in the Foundry adapter so that we know whether to target attachments or media."
            );
            invariant(
                getAttachmentProviderType(target) === "attachment",
                "Foundry media references must be uploaded during action execution."
            );
            const filename = getAttachmentName(blob) ?? "";
            if (!isFoundryAttachmentRid(attachment.id)) {
                const uploaded = await Attachments.upload(opts.client, blob, { filename });
                return {
                    ...attachment,
                    id: uploaded.rid,
                };
            }
            try {
                await Attachments.get(opts.client, attachment.id);
                return;
            } catch (error) {
                if (!isFoundryNotFoundError(error)) {
                    throw error;
                }
            }
            await Attachments.uploadWithRid(opts.client, attachment.id, blob, {
                filename,
                preview: true,
            });
        },
        getAttachmentContent: async (attachment, readOptions) => {
            const client = withRequestSignal(opts.client, readOptions?.signal);
            const userContent = await opts.users?.getAttachmentContent?.(client, attachment);
            if (userContent) return userContent;
            const media = decodeFoundryMediaId(attachment.id);
            if (media) {
                const source = attachment.source;
                invariant(
                    source,
                    `Foundry media attachment "${attachment.id}" is missing its object property source.`
                );
                const response = await MediaReferenceProperties.getMediaContent(
                    client,
                    client.ontologyRid,
                    source.objectType,
                    String(source.primaryKey),
                    source.property,
                    { preview: true }
                );
                return response.blob();
            }
            const contents = await Attachments.read(client, attachment.id);
            return contents.blob();
        },
        getAttachmentMetadata: async (attachment, selection, readOptions) => {
            const client = withRequestSignal(opts.client, readOptions?.signal);
            const userMetadata = await opts.users?.getAttachmentMetadata?.(client, attachment, selection);
            if (userMetadata) return userMetadata;
            const media = decodeFoundryMediaId(attachment.id);
            if (media) {
                const result: PartialAttachmentMetadata = {};
                if (attachment.type !== undefined) {
                    result.type = attachment.type;
                }
                if (selection.includes("dimensions")) {
                    const detailed = await MediaSets.metadata(client, media.mediaSetRid, media.mediaItemRid);
                    result.size = detailed.sizeBytes;
                    if (detailed.type === "imagery" && detailed.dimensions) {
                        result.dimensions = {
                            width: detailed.dimensions.width,
                            height: detailed.dimensions.height,
                        };
                    }
                }
                const missingMetadata = selection.filter((field) => result[field] === undefined);
                const needsBasicMetadata = missingMetadata.some((field) => field !== "dimensions");
                if (!needsBasicMetadata) return result;

                const source = attachment.source;
                invariant(
                    source,
                    `Foundry media attachment "${attachment.id}" is missing its object property source.`
                );
                const info = await MediaReferenceProperties.getMediaMetadata(
                    client,
                    client.ontologyRid,
                    source.objectType,
                    String(source.primaryKey),
                    source.property,
                    { preview: true }
                );
                return {
                    ...result,
                    size: Number(info.sizeBytes),
                    type: info.mediaType,
                    name: info.path,
                };
            }
            const metadata = await Attachments.get(client, attachment.id);
            return {
                id: attachment.id,
                size: Number(metadata.sizeBytes),
                type: metadata.mediaType,
                name: metadata.filename,
            };
        },
    };

    // Submission only calls provider APIs; Replica owns read-back and confirmation.
    const submitAction = async (
        name: string,
        parameters: Record<string, unknown>,
        context: import("@party-stack/ontology").ApplyActionLiveOpts,
        client = opts.client
    ) => {
        const mediaReferences = new Map<string, Awaited<ReturnType<typeof MediaSets.uploadMedia>>>();
        const attachmentIdMappings: OntologyAttachmentIdMapping[] = [];
        await Promise.all(
            [
                ...new Map(
                    (context.attachmentUploads ?? []).map((upload) => [upload.attachment.id, upload])
                ).values(),
            ].map(async (upload) => {
                invariant(
                    getAttachmentProviderType(upload.target) === "media",
                    `Foundry attachment "${upload.attachment.id}" was not materialized before action execution.`
                );
                const reference = await MediaSets.uploadMedia(client, upload.blob, {
                    filename: getAttachmentName(upload.blob) ?? upload.attachment.id,
                });
                mediaReferences.set(upload.attachment.id, reference);
                attachmentIdMappings.push({
                    localId: upload.attachment.id,
                    remoteId: mediaReferenceToFoundryMediaId(reference),
                });
            })
        );
        const actionCodec = createFoundryCodec(opts.ir, {
            resolveMediaReference: (id) => mediaReferences.get(id),
        });
        let invocation: ReturnType<typeof prepareFoundryActionInvocation>;
        try {
            invocation = prepareFoundryActionInvocation({
                ir: opts.ir,
                name,
                parameters,
                codec: actionCodec,
            });
        } catch (cause) {
            throw new BackendError({
                operation: "foundry.prepare",
                kind: "Rejected",
                retryable: false,
                invocationOutcome: "not-committed",
                message: cause instanceof Error ? cause.message : "Invalid action parameters.",
                cause,
            });
        }

        let result: ApplyActionResult;
        try {
            result = await Actions.applyWithOverrides(
                client,
                client.ontologyRid,
                toFoundryActionTypeName(name),
                {
                    request: {
                        options: {
                            mode: "VALIDATE_AND_EXECUTE",
                            returnEdits: "ALL_V2_WITH_DELETIONS",
                        },
                        parameters: invocation.parameters,
                    },
                    overrides: invocation.overrides,
                },
                // oxlint-disable-next-line typescript/no-unsafe-argument
                {
                    preview: true,
                    // oxlint-disable-next-line typescript/no-explicit-any
                }
            );
        } catch (error) {
            if (isFoundryNotFoundError(error)) {
                throw new NonRetryableError(
                    error instanceof Error ? error.message : "Foundry action target was not found.",
                    { cause: error }
                );
            }
            throw error;
        }
        if (result.validation?.result === "INVALID") {
            throw new NonRetryableError("Invalid Action arguments.");
        }
        return { result, attachmentIdMappings };
    };

    const runQueryFunction = async (
        name: string,
        parameters: Record<string, unknown>,
        client = opts.client
    ) => {
        const queryFunctionType = opts.ir.queryFunctionTypes.find((candidate) => candidate.name === name);
        if (!queryFunctionType) {
            throw new Error(`Unknown Foundry query function type "${name}".`);
        }

        const parameterTypes = new Map(
            queryFunctionType.parameters.map((parameter) => [parameter.name, parameter.type])
        );
        const requestParameters: Record<string, unknown> = {};
        for (const [parameterName, value] of Object.entries(parameters)) {
            if (value === undefined) continue;
            const parameterType = parameterTypes.get(parameterName);
            requestParameters[parameterName] = parameterType
                ? codec.encodeValue(parameterType, value)
                : value;
        }

        const result = await Queries.execute(client, client.ontologyRid, name, {
            parameters: requestParameters,
        });

        return codec.decodeValue(queryFunctionType.returnType, result.value);
    };
    const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
            try: run,
            catch: (cause) =>
                new BackendError({
                    operation,
                    kind: "Unavailable",
                    message: "Foundry helper request failed.",
                    retryable: true,
                    cause,
                }),
        });
    const adapter: OntologyBackendAdapter = {
        name: "foundry",
        open: (context) =>
            makeFoundryBackend({
                client: opts.client,
                ir: opts.ir,
                context,
                live: opts.live,
                users: opts.users && {
                    objectType: opts.users.objectType,
                    loadSubset: (query, signal) => opts.users!.loadSubset(opts.client, query, signal),
                },
                submitAction: (invocation, signal) =>
                    submitAction(
                        invocation.name,
                        invocation.parameters,
                        {
                            objects: {},
                            context,
                            attachmentUploads: invocation.attachmentUploads
                                ? [...invocation.attachmentUploads]
                                : undefined,
                        },
                        withRequestSignal(opts.client, signal)
                    ),
                decodeObject: (objectType, value) => codec.decodeObject(objectType, value),
                queryFunction: (name, parameters, signal) =>
                    runQueryFunction(name, parameters, withRequestSignal(opts.client, signal)),
                attachments: {
                    read: (value, range) =>
                        Effect.gen(function* () {
                            if (
                                range &&
                                (!Number.isSafeInteger(range.offset ?? 0) ||
                                    (range.offset ?? 0) < 0 ||
                                    (range.length !== undefined &&
                                        (!Number.isSafeInteger(range.length) || range.length < 0)))
                            )
                                return yield* new BackendError({
                                    operation: "attachment.read",
                                    kind: "Rejected",
                                    message: "Invalid byte range.",
                                    retryable: false,
                                });
                            const blob = yield* attempt("attachment.read", (signal) =>
                                attachments.getAttachmentContent(value, { signal })
                            );
                            return range
                                ? blob.slice(
                                      range.offset ?? 0,
                                      range.length === undefined
                                          ? undefined
                                          : (range.offset ?? 0) + range.length,
                                      blob.type
                                  )
                                : blob;
                        }),
                    metadata: (value) =>
                        Effect.gen(function* () {
                            const meta = yield* attempt(
                                "attachment.metadata",
                                async (signal) =>
                                    (await attachments.getAttachmentMetadata?.(
                                        value,
                                        ["size", "type", "name"],
                                        { signal }
                                    )) ?? {}
                            );
                            if (meta.size !== undefined && meta.type !== undefined)
                                return { size: meta.size, type: meta.type, name: meta.name };
                            const blob = yield* attempt("attachment.read", (signal) =>
                                attachments.getAttachmentContent(value, { signal })
                            );
                            return { size: blob.size, type: blob.type, name: meta.name };
                        }),
                },
            }),
        live: opts.live !== false,
        validateAction: async (name: string, parameters: Record<string, unknown>) => {
            const invocation = prepareFoundryActionInvocation({
                ir: opts.ir,
                name,
                parameters,
                codec,
            });

            let result: ApplyActionResult;
            try {
                result = await Actions.applyWithOverrides(
                    opts.client,
                    opts.client.ontologyRid,
                    toFoundryActionTypeName(name),
                    {
                        request: {
                            options: {
                                mode: "VALIDATE_ONLY",
                            },
                            parameters: invocation.parameters,
                        },
                        overrides: invocation.overrides,
                    },
                    // oxlint-disable-next-line typescript/no-unsafe-argument
                    {
                        preview: true,
                        // oxlint-disable-next-line typescript/no-explicit-any
                    }
                );
            } catch (error) {
                if (isFoundryNotFoundError(error)) {
                    throw new NonRetryableError(
                        error instanceof Error ? error.message : "Foundry action target was not found.",
                        { cause: error }
                    );
                }
                throw error;
            }

            if (!result.validation) {
                throw new Error("Foundry validate action response did not include a validation result.");
            }
            return {
                certain: true,
                value:
                    result.validation.result === "VALID"
                        ? {
                              kind: "ok",
                              value: undefined,
                          }
                        : {
                              kind: "err",
                              value: getFoundryValidationIssues(result),
                          },
            };
        },
        validateActionDraft: async (
            name: string,
            parameters: Record<string, unknown>,
            live: ValidateActionDraftLiveOpts
        ) => {
            const actionType = opts.ir.actionTypes.find((candidate) => candidate.name === name);
            if (!actionType) {
                throw new NonRetryableError(`Unknown Foundry action type "${name}".`);
            }
            const knownParameters = new Set([
                ...Object.entries(parameters).flatMap(([parameterName, value]) =>
                    value === undefined ? [] : [parameterName]
                ),
                ...live.knownParameters,
            ]);
            const missingKnownRequiredParameters = actionType.parameters.filter(
                (parameter) =>
                    parameters[parameter.name] === undefined &&
                    knownParameters.has(parameter.name) &&
                    !unwrapType(resolveType(opts.ir, parameter.type)).isOptional
            );
            if (missingKnownRequiredParameters.length > 0) {
                return certain({
                    kind: "err",
                    value: missingKnownRequiredParameters.map((parameter) => ({
                        message: `Required action parameter "${parameter.name}" is missing.`,
                        path: [parameter.name],
                    })),
                });
            }
            const hasUnknownParameters = actionType.parameters.some(
                (parameter) =>
                    parameters[parameter.name] === undefined && !knownParameters.has(parameter.name)
            );
            if (!hasUnknownParameters) {
                return adapter.validateAction!(name, parameters, live);
            }

            const userId = typeof live.context?.user === "string" ? live.context.user : undefined;
            if (!userId) {
                return uncertain();
            }
            const criteria = await loadFoundrySubmissionCriteria({
                client: opts.client,
                actionTypeName: name,
                userId,
            });
            return validateFoundryActionDraftCriteria({
                client: opts.client,
                criteria,
                userId,
                parameters,
                knownParameters,
            });
        },
        attachments,
    };
    return adapter;
}

export type CreateFoundryOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (
    | {
          client: OntologyClient;
      }
    | {
          createClient: (ir: OntologyIR, context: Context) => OntologyClient | Promise<OntologyClient>;
      }
) & {
    users?: FoundryUsersIntegration;
    live?: boolean;
};

export function createFoundryOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateFoundryOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createFoundryOntologyBackendAdapter({
            ir,
            client: "client" in opts ? opts.client : await opts.createClient(ir, context),
            users: opts.users,
            live: opts.live,
        });
}
