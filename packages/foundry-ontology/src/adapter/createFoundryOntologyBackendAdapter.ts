import { invariant } from "@bobbyfidz/panic";
import { MediaSets } from "@osdk/foundry.mediasets";
import {
    Actions,
    AttachmentRid,
    Attachments,
    MediaReferenceProperties,
    Queries,
} from "@osdk/foundry.ontologies";
import { BackendError, classifyBackendFailure } from "@party-stack/ontology-backend";
import { certain, uncertain, type OntologyIR } from "@party-stack/ontology-spec";
import { resolveType, unwrapType } from "@party-stack/ontology-spec/utils";
import {
    byteSource,
    byteChunks,
    readableByteSource,
    sliceByteSource,
    type ByteInput,
} from "@party-stack/ontology-storage/blobs";
import { Effect, Stream, Schema, Redacted, type Types } from "effect";
import { Temporal } from "temporal-polyfill";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { getFoundryAttachmentKind } from "../meta/foundryAttachmentMetadata.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { makeFoundryBackend } from "./backend.js";
import { makeFoundryEncryptedValues } from "./encrypted.js";
import { foundryActionError } from "./foundryActionError.js";
import {
    getFoundryValidationIssues,
    loadFoundrySubmissionCriteria,
    validateFoundryActionDraftCriteria,
} from "./foundryActionValidation.js";
import { createFoundryCodec } from "./foundryCodec.js";
import { decodeFoundryMediaId, mediaReferenceToFoundryMediaId } from "./foundryMediaId.js";
import { uploadFoundryMedia, uploadFoundryAttachment } from "./uploads.js";
import type { OntologyClient } from "@party-stack/foundry-client";
import type {
    BackendAttachments,
    BackendSnapshot,
    ValidationReport,
    ActionReceipt,
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
} from "@party-stack/ontology-backend";
type PartialAttachmentMetadata = Types.Mutable<Effect.Success<ReturnType<BackendAttachments["metadata"]>>>;
type OntologyAttachmentIdMapping = NonNullable<ActionReceipt["attachmentIdMappings"]>[number];
import type { attachment } from "@party-stack/ontology-spec/values";
import type { Query } from "@party-stack/ontology-storage";

const attachmentFailure = (kind: "InvalidRequest" | "InvalidResponse", message: string) =>
    new BackendError({
        operation: "foundry.attachment",
        kind,
        message,
        retryable: false,
    });

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
    getAttachmentContent?(client: OntologyClient, attachment: attachment): Promise<ByteInput | undefined>;
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
        throw new BackendError({
            operation: "foundry.prepare",
            kind: "InvalidRequest",
            retryable: false,
            actionOutcome: "not-committed",
            message: `Unknown Foundry action type "${options.name}".`,
        });
    }
    const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
    const parameterTypes = new Map(
        actionType.parameters.map((parameter) => [parameter.name, parameter.type])
    );
    const parameters: Record<string, unknown> = {};
    const uniqueIdentifierLinkIdValues: Record<string, string> = {};
    let actionExecutionTime: string | undefined;

    try {
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
    } catch (cause) {
        throw new BackendError({
            operation: "foundry.prepare",
            kind: "InvalidRequest",
            retryable: false,
            actionOutcome: "not-committed",
            message: "Invalid action parameters.",
            cause: Redacted.make(cause),
        });
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
    watch?: boolean;
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
    const Validation = Schema.Struct({ result: Schema.Literals(["VALID", "INVALID"]) });
    const ActionResponse = Schema.Struct({ validation: Schema.optional(Validation) });
    const ValidationResponse = Schema.Struct({ validation: Validation });
    const attachments = {
        materializeAttachment: async (
            attachment: attachment,
            input: ByteInput,
            {
                target,
                signal,
            }: { target?: import("@party-stack/ontology-spec").AttachmentTypeDef; signal?: AbortSignal },
            client = opts.client
        ) => {
            invariant(
                target,
                "A property target must be passed to materializeAttachment in the Foundry adapter so that we know whether to target attachments or media."
            );
            invariant(
                getAttachmentProviderType(target) === "attachment",
                "Foundry media references must be uploaded during action execution."
            );
            const filename = byteSource(input).name ?? "";
            if (!isFoundryAttachmentRid(attachment.id)) {
                const uploaded = await uploadFoundryAttachment(client, input, { filename, signal });
                return {
                    ...attachment,
                    id: uploaded.rid,
                };
            }
            try {
                await Attachments.get(client, attachment.id);
                return;
            } catch (error) {
                if (!isFoundryNotFoundError(error)) {
                    throw error;
                }
            }
            await uploadFoundryAttachment(client, input, { filename, rid: attachment.id, signal });
        },
        getAttachmentContent: async (attachment: attachment, readOptions?: { signal?: AbortSignal }) => {
            const client = withRequestSignal(opts.client, readOptions?.signal);
            const userContent = await opts.users?.getAttachmentContent?.(client, attachment);
            if (userContent) return userContent;
            const media = decodeFoundryMediaId(attachment.id);
            if (media) {
                const source = attachment.source;
                if (!source)
                    throw attachmentFailure(
                        "InvalidRequest",
                        "Media reads require an object property source."
                    );
                const response = await MediaReferenceProperties.getMediaContent(
                    client,
                    client.ontologyRid,
                    source.objectType,
                    String(source.primaryKey),
                    source.property,
                    { preview: true }
                );
                if (!response.body)
                    throw attachmentFailure("InvalidResponse", "Foundry returned no media body.");
                return readableByteSource(response.body, {
                    type: response.headers.get("content-type") ?? attachment.type,
                });
            }
            const contents = await Attachments.read(client, attachment.id);
            if (!contents.body)
                throw attachmentFailure("InvalidResponse", "Foundry returned no attachment body.");
            return readableByteSource(contents.body, {
                type: contents.headers.get("content-type") ?? attachment.type,
            });
        },
        getAttachmentMetadata: async (
            attachment: attachment,
            selection: readonly (keyof PartialAttachmentMetadata)[],
            readOptions?: { signal?: AbortSignal }
        ): Promise<PartialAttachmentMetadata> => {
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
                if (!source)
                    throw attachmentFailure(
                        "InvalidRequest",
                        "Media reads require an object property source."
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
        context: {
            attachmentUploads?: readonly import("@party-stack/ontology-backend").AttachmentUpload[];
            signal?: AbortSignal;
        },
        client = opts.client
    ) => {
        if (!opts.ir.actionTypes.some((action) => action.name === name))
            throw new BackendError({
                operation: "foundry.applyAction",
                kind: "InvalidRequest",
                retryable: false,
                actionOutcome: "not-committed",
                message: "Unknown Foundry action type.",
            });
        const mediaReferences = new Map<string, Awaited<ReturnType<typeof MediaSets.uploadMedia>>>();
        const attachmentIdMappings: OntologyAttachmentIdMapping[] = [];
        const attachmentIds = new Map<string, string>();
        await Promise.all(
            [
                ...new Map(
                    (context.attachmentUploads ?? []).map((upload) => [upload.attachment.id, upload])
                ).values(),
            ].map(async (upload) => {
                if (getAttachmentProviderType(upload.target) !== "media") {
                    const result = await attachments.materializeAttachment(
                        upload.attachment,
                        upload.blob,
                        {
                            target: upload.target,
                            signal: context.signal,
                        },
                        client
                    );
                    const id = result?.id ?? upload.attachment.id;
                    attachmentIds.set(upload.attachment.id, id);
                    if (id !== upload.attachment.id)
                        attachmentIdMappings.push({ localId: upload.attachment.id, remoteId: id });
                    return;
                }
                const reference = await uploadFoundryMedia(client, upload.blob, {
                    filename: getAttachmentName(upload.blob) ?? upload.attachment.id,
                    signal: context.signal,
                });
                mediaReferences.set(upload.attachment.id, reference);
                attachmentIdMappings.push({
                    localId: upload.attachment.id,
                    remoteId: mediaReferenceToFoundryMediaId(reference),
                });
            })
        ).catch((cause) => {
            const error = foundryActionError("foundry.upload", cause, opts.ir, name, parameters);
            throw new BackendError({
                operation: error.operation,
                kind: error.kind,
                message: error.message,
                retryable: error.retryable,
                issues: error.issues,
                cause: error.cause,
                actionOutcome: "not-committed",
            });
        });
        const actionCodec = createFoundryCodec(opts.ir, {
            resolveMediaReference: (id) => mediaReferences.get(id),
            resolveAttachmentId: (id) => attachmentIds.get(id),
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
            if (cause instanceof BackendError) throw cause;
            throw new BackendError({
                operation: "foundry.prepare",
                kind: "InvalidRequest",
                retryable: false,
                actionOutcome: "not-committed",
                message: "Invalid action parameters.",
                cause: Redacted.make(cause),
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
            throw foundryActionError("foundry.applyAction", error, opts.ir, name, parameters);
        }
        try {
            Schema.decodeUnknownSync(ActionResponse)(result);
        } catch (cause) {
            throw new BackendError({
                operation: "foundry.applyAction",
                kind: "InvalidResponse",
                retryable: false,
                actionOutcome: "unknown",
                message: "Foundry returned an invalid action response.",
                cause: Redacted.make(cause),
            });
        }
        if (result.validation?.result === "INVALID") {
            throw new BackendError({
                operation: "foundry.applyAction",
                kind: "ValidationFailed",
                message: "Submission failed validation.",
                issues: getFoundryValidationIssues(result, parameters),
                retryable: false,
                actionOutcome: "not-committed",
            });
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
            throw new BackendError({
                operation: "foundry.queryFunction",
                kind: "InvalidRequest",
                retryable: false,
                message: `Unknown Foundry query function type "${name}".`,
            });
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

        try {
            return codec.decodeValue(queryFunctionType.returnType, result.value);
        } catch (cause) {
            throw new BackendError({
                operation: "foundry.queryFunction",
                kind: "InvalidResponse",
                retryable: false,
                message: "Foundry returned an invalid query result.",
                cause: Redacted.make(cause),
            });
        }
    };
    const attempt = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
            try: run,
            catch: (cause) => classifyBackendFailure(operation, cause),
        });
    const validateAction = Effect.fn("Foundry.validateAction")(function* (
        name: string,
        parameters: Record<string, unknown>
    ): Effect.fn.Return<ValidationReport, BackendError> {
        const invocation = yield* Effect.try({
            try: () => prepareFoundryActionInvocation({ ir: opts.ir, name, parameters, codec }),
            catch: (cause) => foundryActionError("foundry.validateAction", cause, opts.ir, name, parameters),
        });
        const result = yield* Effect.tryPromise({
            try: (signal) =>
                Actions.applyWithOverrides(
                    withRequestSignal(opts.client, signal),
                    opts.client.ontologyRid,
                    toFoundryActionTypeName(name),
                    {
                        request: {
                            options: { mode: "VALIDATE_ONLY" },
                            parameters: invocation.parameters,
                        },
                        overrides: invocation.overrides,
                    },
                    { preview: true }
                ),
            catch: (cause) => foundryActionError("foundry.validateAction", cause, opts.ir, name, parameters),
        });
        const { validation } = yield* Schema.decodeUnknownEffect(ValidationResponse)(result).pipe(
            Effect.mapError(
                (cause) =>
                    new BackendError({
                        operation: "foundry.validateAction",
                        kind: "InvalidResponse",
                        retryable: false,
                        actionOutcome: "not-committed",
                        message: "Foundry returned an invalid validation response.",
                        cause: Redacted.make(cause),
                    })
            )
        );
        return certain(
            validation.result === "VALID"
                ? { kind: "ok" as const, value: undefined }
                : { kind: "err" as const, value: getFoundryValidationIssues(result, parameters) }
        );
    });
    const validateActionDraft = Effect.fn("Foundry.validateActionDraft")(function* (
        name: string,
        parameters: Record<string, unknown>,
        live: { knownParameters: readonly string[]; context?: Record<string, unknown> }
    ): Effect.fn.Return<ValidationReport, BackendError> {
        const action = opts.ir.actionTypes.find((candidate) => candidate.name === name);
        if (!action)
            return yield* new BackendError({
                operation: "foundry.validateActionDraft",
                kind: "InvalidRequest",
                message: "Unknown action type.",
                retryable: false,
            });
        const knownParameters = new Set([
            ...Object.entries(parameters).flatMap(([key, value]) => (value === undefined ? [] : [key])),
            ...live.knownParameters,
        ]);
        const missing = action.parameters.filter(
            (parameter) =>
                parameters[parameter.name] === undefined &&
                knownParameters.has(parameter.name) &&
                !unwrapType(resolveType(opts.ir, parameter.type)).isOptional
        );
        if (missing.length)
            return certain({
                kind: "err" as const,
                value: missing.map((parameter) => ({
                    message: "A value is required.",
                    path: [parameter.name],
                    code: "required",
                    category: "input" as const,
                    source: "parameter" as const,
                    messageSource: "standard" as const,
                })),
            });
        if (
            !action.parameters.some(
                (parameter) =>
                    parameters[parameter.name] === undefined && !knownParameters.has(parameter.name)
            )
        )
            return yield* validateAction(name, parameters);
        const userId = typeof live.context?.user === "string" ? live.context.user : undefined;
        if (!userId) return uncertain();
        return yield* Effect.tryPromise({
            try: async (signal) =>
                validateFoundryActionDraftCriteria({
                    client: withRequestSignal(opts.client, signal),
                    criteria: await loadFoundrySubmissionCriteria({
                        client: withRequestSignal(opts.client, signal),
                        actionTypeName: name,
                        userId,
                    }),
                    userId,
                    parameters,
                    knownParameters,
                }),
            catch: (cause) =>
                foundryActionError("foundry.validateActionDraft", cause, opts.ir, name, parameters),
        });
    });
    const adapter: OntologyBackendAdapter = {
        name: "foundry",
        open: (context) =>
            makeFoundryBackend({
                client: opts.client,
                ir: opts.ir,
                context,
                watch: opts.watch,
                encrypted: makeFoundryEncryptedValues(opts.client, opts.ir),
                users: opts.users && {
                    objectType: opts.users.objectType,
                    loadSubset: (query, signal) => opts.users!.loadSubset(opts.client, query, signal),
                },
                submitAction: (invocation, signal) =>
                    submitAction(
                        invocation.name,
                        invocation.parameters,
                        {
                            signal,
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
                    stage: (value, blob, settings) =>
                        attempt("attachment.stage", async (signal) => {
                            const target = settings?.target;
                            if (!target || getAttachmentProviderType(target) === "media")
                                throw new BackendError({
                                    operation: "attachment.stage",
                                    kind: "NotImplemented",
                                    retryable: false,
                                    message:
                                        "This attachment target must be uploaded during action execution.",
                                });
                            return (
                                (await attachments.materializeAttachment(
                                    value,
                                    blob,
                                    { target, signal },
                                    withRequestSignal(opts.client, signal)
                                )) ?? value
                            );
                        }),
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
                                    kind: "InvalidRequest",
                                    message: "Invalid byte range.",
                                    retryable: false,
                                });
                            const blob = yield* attempt("attachment.read", (signal) =>
                                attachments.getAttachmentContent(value, { signal })
                            );
                            return range
                                ? sliceByteSource(blob, range.offset ?? 0, range.length)
                                : byteSource(blob);
                        }),
                    metadata: (value, settings) =>
                        Effect.gen(function* () {
                            const meta = yield* attempt(
                                "attachment.metadata",
                                async (signal) =>
                                    (await attachments.getAttachmentMetadata?.(
                                        value,
                                        settings?.select ?? ["size", "type", "name"],
                                        { signal }
                                    )) ?? {}
                            );
                            if (settings?.select || (meta.size !== undefined && meta.type !== undefined))
                                return {
                                    size: meta.size,
                                    type: meta.type,
                                    name: meta.name,
                                    dimensions: meta.dimensions ?? undefined,
                                };
                            const blob = yield* attempt("attachment.read", (signal) =>
                                attachments.getAttachmentContent(value, { signal })
                            );
                            const source = byteSource(blob);
                            const size =
                                source.size ??
                                (yield* byteChunks(source).pipe(
                                    Stream.runFold(
                                        () => 0,
                                        (total, chunk) => total + chunk.length
                                    ),
                                    Effect.mapError(
                                        (cause) =>
                                            new BackendError({
                                                operation: "attachment.metadata",
                                                kind: "Unavailable",
                                                message: "Attachment metadata is unavailable.",
                                                retryable: true,
                                                cause,
                                            })
                                    )
                                ));
                            return {
                                size,
                                type: source.type,
                                name: meta.name,
                                dimensions: meta.dimensions ?? undefined,
                            };
                        }),
                },
            }).pipe(
                Effect.map((native) => ({
                    ...native,
                    validateAction: (
                        name: string,
                        parameters: Record<string, unknown>,
                        settings?: { readonly knownParameters?: readonly string[] }
                    ) =>
                        settings?.knownParameters
                            ? validateActionDraft(name, parameters, {
                                  context,
                                  knownParameters: settings.knownParameters,
                              })
                            : validateAction(name, parameters),
                }))
            ),
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
    watch?: boolean;
};

export function createFoundryOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateFoundryOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return (ir, context) => ({
        name: "foundry",
        open: (executionContext) =>
            Effect.gen(function* () {
                const client = yield* Effect.tryPromise({
                    try: async () => ("client" in opts ? opts.client : opts.createClient(ir, context)),
                    catch: (cause) => classifyBackendFailure("foundry.open", cause),
                });
                const adapter = yield* Effect.try({
                    try: () =>
                        createFoundryOntologyBackendAdapter({
                            ir,
                            client,
                            users: opts.users,
                            watch: opts.watch,
                        }),
                    catch: (cause) =>
                        new BackendError({
                            operation: "foundry.open",
                            kind: "InvalidConfiguration",
                            message: "Invalid Foundry backend configuration.",
                            retryable: false,
                            cause: Redacted.make(cause),
                        }),
                });
                return yield* adapter.open(executionContext);
            }),
    });
}
