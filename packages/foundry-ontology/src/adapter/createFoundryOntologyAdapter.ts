import { invariant } from "@bobbyfidz/panic";
import {
    Actions,
    AttachmentRid,
    Attachments,
} from "@osdk/foundry.ontologies";
import {
    type OntologyAdapter,
    type OntologyAttachmentsAdapter,
    type OntologyIR,
} from "@party-stack/ontology";
import { Collection, NonRetriableError } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";
import type { OntologyClient } from "@party-stack/foundry-client";
import { getFoundryActionOverrideParameterMapping } from "../meta/convertMetaActionType.js";
import { toFoundryActionTypeName } from "../utils/actionTypeName.js";
import { createFoundryCodec } from "./foundryCodec.js";
import { objectCollectionOptions, type ObjectCollectionUtils } from "./objectCollectionOptions.js";

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

function getAttachmentProviderTypeFromId(id: string): "attachment" | "media" {
    return id.startsWith("ri.mio.") ? "media" : "attachment";
}

function unsupportedMediaAttachmentOperation(): never {
    throw new Error(
        "Foundry media attachment operations are not supported yet because Foundry does not currently expose enough MediaSet metadata to resolve media items by attachment id."
    );
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

export function createFoundryOntologyAdapter(opts: {
    client: OntologyClient;
    ir: OntologyIR;
}): OntologyAdapter {
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
            unsupportedMediaAttachmentOperation();
        },
        materializeAttachment: async (attachment, blob, { target }) => {
            invariant(
                target,
                "A property target must be passed to materializeAttachment in the Foundry adapter so that we know whether to target attachments or media."
            );
            const attachmentName = getAttachmentName(attachment as unknown);
            if (getAttachmentProviderType(target) === "attachment") {
                await Attachments.uploadWithRid(opts.client, attachment.id as AttachmentRid, blob, {
                    filename: attachmentName ?? "",
                    preview: true,
                });
                return;
            }

            void attachment;
            void blob;
            unsupportedMediaAttachmentOperation();
        },
        getAttachmentContent: async (attachment) => {
            if (getAttachmentProviderTypeFromId(attachment.id) === "media") {
                unsupportedMediaAttachmentOperation();
            }
            const contents = await Attachments.read(opts.client, attachment.id as AttachmentRid);
            return contents.blob();
        },
        getAttachmentMetadata: async (attachment) => {
            if (getAttachmentProviderTypeFromId(attachment.id) === "media") {
                unsupportedMediaAttachmentOperation();
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
                decodeObject: (object) => codec.decodeObject(objectType, object) as FoundryObject,
            });
        },
        applyAction: async (name, parameters, context) => {
            const actionType = opts.ir.actionTypes.find((actionType) => actionType.name === name)!;
            const overrideMapping = getFoundryActionOverrideParameterMapping(actionType);
            const parameterTypes = new Map(actionType.parameters.map((p) => [p.name, p.type]));
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
                        ? codec.encodeValue(paramType, value)
                        : value;
                }
            }

            const result: ApplyActionResult = await Actions.applyWithOverrides(
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
            if (result.validation?.result === "INVALID") {
                throw new NonRetriableError("Invalid Action arguments.");
            }
            if (context) {
                const operationId = getApplyActionOperationId(result);
                const targetCollections = Array.from(getEditedObjectTypes(result.edits))
                    .map((objectType) => context.objects[objectType] as CollectionWithUtils | undefined)
                    .filter((collection): collection is CollectionWithUtils =>
                        Boolean(collection?.utils?.awaitOperationId)
                    );

                await Promise.all(
                    targetCollections.map((collection) => collection.utils.awaitOperationId(operationId))
                );
            }
        },
        attachments,
    };
}
