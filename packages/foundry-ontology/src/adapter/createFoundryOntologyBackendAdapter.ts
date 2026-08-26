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
    NonRetryableError,
    type PartialAttachmentMetadata,
    type OntologyAttachmentIdMapping,
    type OntologyBackendAdapter,
    type OntologyBackendAdapterProvider,
    type OntologyAttachmentsAdapter,
    type OntologyIR,
} from "@party-stack/ontology";
import { Collection } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import type { OntologyClient } from "@party-stack/foundry-client";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { createFoundryCodec } from "./foundryCodec.js";
import { decodeFoundryMediaId, mediaReferenceToFoundryMediaId } from "./foundryMediaId.js";
import { objectCollectionOptions, type ObjectCollectionUtils } from "./objectCollectionOptions.js";

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

type FoundryObject = Record<string, unknown>;

type CollectionWithUtils = Collection<Record<string, unknown>, string | number, ObjectCollectionUtils>;
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

function getApplyActionOperationId(result: ApplyActionResult): string {
    const operationId = result.operationId;
    if (typeof operationId !== "string" || operationId.length === 0) {
        throw new Error("Foundry apply action response did not include an operationId.");
    }
    return operationId;
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
    return target?.meta?.type === "media" ? "media" : "attachment";
}

function getEditedObjectTypes(
    edits: Awaited<ReturnType<typeof Actions.applyWithOverrides>>["edits"]
): Set<string> {
    const objectTypes = new Set<string>();
    if (!edits || edits.type !== "edits") {
        return objectTypes;
    }

    for (const edit of edits.edits) {
        if (edit.type === "addObject" || edit.type === "modifyObject" || edit.type === "deleteObject") {
            objectTypes.add(edit.objectType);
        }
    }

    return objectTypes;
}

export function createFoundryOntologyBackendAdapter(opts: {
    client: OntologyClient;
    ir: OntologyIR;
}): OntologyBackendAdapter {
    const codec = createFoundryCodec(opts.ir);
    const attachments: OntologyAttachmentsAdapter = {
        generateAttachmentId: (_, { target }) => {
            invariant(
                target,
                "A property target must be passed to generateAttachmentId in the Foundry adapter so that we know whether to target attachments or media."
            );
            const meta = target.meta as { type: "attachment" | "media" };
            if (meta.type === "attachment") {
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
            try {
                await Attachments.get(opts.client, attachment.id as AttachmentRid);
                return;
            } catch {
                // The stable attachment RID has not been materialized yet.
            }
            await Attachments.uploadWithRid(opts.client, attachment.id as AttachmentRid, blob, {
                filename: getAttachmentName(blob) ?? "",
                preview: true,
            });
        },
        getAttachmentContent: async (attachment) => {
            const media = decodeFoundryMediaId(attachment.id);
            if (media) {
                const source = attachment.source;
                invariant(
                    source,
                    `Foundry media attachment "${attachment.id}" is missing its object property source.`
                );
                const response = await MediaReferenceProperties.getMediaContent(
                    opts.client,
                    opts.client.ontologyRid,
                    source.objectType,
                    String(source.primaryKey),
                    source.property,
                    { preview: true }
                );
                return response.blob();
            }
            const contents = await Attachments.read(opts.client, attachment.id as AttachmentRid);
            return contents.blob();
        },
        getAttachmentMetadata: async (attachment, selection) => {
            const media = decodeFoundryMediaId(attachment.id);
            if (media) {
                const result: PartialAttachmentMetadata = {};
                if (attachment.type !== undefined) {
                    result.type = attachment.type;
                }
                if (selection.includes("dimensions")) {
                    const detailed = await MediaSets.metadata(
                        opts.client,
                        media.mediaSetRid,
                        media.mediaItemRid,
                        { preview: true }
                    );
                    result.size = detailed.sizeBytes;
                    if (detailed.type === "imagery" && detailed.dimensions) {
                        result.dimensions = {
                            width: detailed.dimensions.width,
                            height: detailed.dimensions.height,
                        };
                    }
                }
                const missingMetadata = selection.filter(
                    (field) => result[field] === undefined
                );
                const needsBasicMetadata = missingMetadata.some(
                    (field) => field !== "dimensions"
                );
                if (!needsBasicMetadata) return result;

                const source = attachment.source;
                invariant(
                    source,
                    `Foundry media attachment "${attachment.id}" is missing its object property source.`
                );
                const info = await MediaReferenceProperties.getMediaMetadata(
                    opts.client,
                    opts.client.ontologyRid,
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
            const metadata = await Attachments.get(opts.client, attachment.id as AttachmentRid);
            return {
                id: attachment.id,
                size: Number(metadata.sizeBytes),
                type: metadata.mediaType,
                name: metadata.filename,
            };
        },
    };

    return {
        name: "foundry",
        getCollectionOptions: (objectType: string) => {
            const objectTypeDef = opts.ir.objectTypes.find((ot) => ot.name === objectType)!;
            return objectCollectionOptions({
                client: opts.client,
                objectType,
                primaryKeyProperty: objectTypeDef.primaryKey,
                selectedProperties: objectTypeDef.properties.map((property) => property.name),
                decodeObject: (object) => codec.decodeObject(objectType, object) as FoundryObject,
            });
        },
        applyAction: async (name, parameters, context) => {
            const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === name)!;
            const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
            const parameterTypes = new Map(actionType.parameters.map((p) => [p.name, p.type]));
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
                    const reference = await MediaSets.uploadMedia(opts.client, upload.blob, {
                        filename: getAttachmentName(upload.blob) ?? upload.attachment.id,
                        preview: true,
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
            const requestParameters: Record<string, unknown> = {};
            const uniqueIdentifierLinkIdValues: Record<string, string> = {};
            let actionExecutionTime: string | undefined;

            for (const [parameterName, value] of Object.entries(parameters)) {
                if (overrideMapping.uuidByParameterName.has(parameterName)) {
                    if (value !== undefined) {
                        uniqueIdentifierLinkIdValues[
                            overrideMapping.uuidByParameterName.get(parameterName)!
                        ] = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (overrideMapping.nowParameterName === parameterName) {
                    if (value !== undefined) {
                        actionExecutionTime = serializeOverrideValue(value);
                    }
                    continue;
                }
                if (value !== undefined) {
                    const paramType = parameterTypes.get(parameterName);
                    requestParameters[parameterName] = paramType
                        ? actionCodec.encodeValue(paramType, value)
                        : value;
                }
            }

            let result: ApplyActionResult;
            try {
                result = await Actions.applyWithOverrides(
                    opts.client,
                    opts.client.ontologyRid,
                    toFoundryActionTypeName(name),
                    {
                        request: {
                            options: {
                                mode: "VALIDATE_AND_EXECUTE",
                                returnEdits: "ALL_V2_WITH_DELETIONS",
                            },
                            parameters: requestParameters,
                        },
                        overrides: {
                            uniqueIdentifierLinkIdValues,
                            actionExecutionTime,
                        },
                    },
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                    {
                        preview: true,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } as any
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
            if (context) {
                const operationId = getApplyActionOperationId(result);
                const editedObjectTypes = Array.from(getEditedObjectTypes(result.edits));
                const targetCollections = editedObjectTypes
                    .map((objectType) => context.objects[objectType] as CollectionWithUtils | undefined)
                    .filter((collection): collection is CollectionWithUtils =>
                        Boolean(collection?.utils?.awaitOperationId)
                    );

                await Promise.all(
                    targetCollections.map((collection) => collection.utils.awaitOperationId(operationId))
                );

                return {
                    ...(editedObjectTypes.length > 0
                        ? { invalidatedObjectTypes: editedObjectTypes }
                        : {}),
                    ...(attachmentIdMappings.length > 0 ? { attachmentIdMappings } : {}),
                };
            }
            const editedObjectTypes = Array.from(getEditedObjectTypes(result.edits));
            if (editedObjectTypes.length === 0 && attachmentIdMappings.length === 0) {
                return undefined;
            }
            return {
                ...(editedObjectTypes.length > 0 ? { invalidatedObjectTypes: editedObjectTypes } : {}),
                ...(attachmentIdMappings.length > 0 ? { attachmentIdMappings } : {}),
            };
        },
        runQueryFunction: async (name, parameters) => {
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

            const result = await Queries.execute(opts.client, opts.client.ontologyRid, name, {
                parameters: requestParameters,
            });

            return codec.decodeValue(queryFunctionType.returnType, result.value);
        },
        attachments,
    };
}

export type CreateFoundryOntologyBackendOptions<
    Context extends Record<string, unknown> = Record<string, unknown>,
> =
    | {
          client: OntologyClient;
      }
    | {
          createClient: (ir: OntologyIR, context: Context) => OntologyClient | Promise<OntologyClient>;
      };

export function createFoundryOntologyBackend<
    Context extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateFoundryOntologyBackendOptions<Context>): OntologyBackendAdapterProvider<Context> {
    return async (ir, context) =>
        createFoundryOntologyBackendAdapter({
            ir,
            client: "client" in opts ? opts.client : await opts.createClient(ir, context),
        });
}
