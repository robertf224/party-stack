import { invariant } from "@bobbyfidz/panic";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { collectActionAttachments } from "@party-stack/ontology-storage/blobs";
import type { BlobManager } from "../../runtime/blobs/types.js";
import type {
    OntologyAttachmentIdMapping,
    OntologyAttachmentUpload,
    OntologyBackendAdapter,
} from "../OntologyBackendAdapter.js";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";
import type { AttachmentReference as ActionAttachment } from "@party-stack/ontology-storage/blobs";

export interface PreparedActionParameters {
    parameters: Record<string, unknown>;
    attachmentUploads: OntologyAttachmentUpload[];
    attachmentIdMappings: OntologyAttachmentIdMapping[];
}

function isAttachment(value: unknown): value is attachment {
    return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

async function collectActionAttachmentUploads(opts: {
    attachments: ActionAttachment[];
    blobManager?: BlobManager;
}): Promise<OntologyAttachmentUpload[]> {
    if (opts.attachments.length === 0) return [];
    const blobManager = opts.blobManager;
    invariant(blobManager, "Missing required BlobManager for collecting attachment uploads.");
    return Promise.all(
        opts.attachments.map(async (entry) => ({
            ...entry,
            blob: await blobManager.read(entry.attachment.id, { meta: { attachment: entry.attachment } }),
        }))
    );
}

async function materializeValue(opts: {
    ir: OntologyIR;
    type: TypeDef;
    value: unknown;
    backendAdapter: OntologyBackendAdapter;
    blobManager: BlobManager;
    materialized: Map<string, Promise<attachment>>;
    mappings: OntologyAttachmentIdMapping[];
    uploads: OntologyAttachmentUpload[];
}): Promise<unknown> {
    if (opts.value === undefined || opts.value === null) {
        return opts.value;
    }
    const materializeAttachment = opts.backendAdapter.attachments?.materializeAttachment;
    invariant(materializeAttachment, "Missing attachment materializer.");
    const type = resolveType(opts.ir, opts.type);
    switch (type.kind) {
        case "attachment": {
            if (!isAttachment(opts.value)) return opts.value;
            const local = opts.value;
            let pending = opts.materialized.get(local.id);
            if (!pending) {
                const materializeOptions = {
                    target: type.value,
                };
                const canMaterialize =
                    opts.backendAdapter.attachments?.canMaterializeAttachment?.(local, materializeOptions) ??
                    true;
                pending = opts.blobManager
                    .read(local.id, { meta: { attachment: local } })
                    .then(async (blob) => {
                        if (!canMaterialize) {
                            opts.uploads.push({
                                attachment: local,
                                target: type.value,
                                blob,
                            });
                            return local;
                        }
                        return (await materializeAttachment(local, blob, materializeOptions)) ?? local;
                    })
                    .then((result) => {
                        const remote = result;
                        if (remote.id !== local.id) {
                            opts.mappings.push({
                                localId: local.id,
                                remoteId: remote.id,
                            });
                        }
                        return remote;
                    });
                opts.materialized.set(local.id, pending);
            }
            return pending;
        }
        case "optional":
            return materializeValue({
                ...opts,
                type: type.value.type,
            });
        case "list":
            if (!Array.isArray(opts.value)) return opts.value;
            return Promise.all(
                opts.value.map((value) =>
                    materializeValue({
                        ...opts,
                        type: type.value.elementType,
                        value,
                    })
                )
            );
        case "map":
            if (typeof opts.value !== "object" || opts.value === null || Array.isArray(opts.value)) {
                return opts.value;
            }
            return Object.fromEntries(
                await Promise.all(
                    Object.entries(opts.value as Record<string, unknown>).map(async ([key, value]) => [
                        key,
                        await materializeValue({
                            ...opts,
                            type: type.value.valueType,
                            value,
                        }),
                    ])
                )
            );
        case "struct": {
            if (typeof opts.value !== "object" || opts.value === null || Array.isArray(opts.value)) {
                return opts.value;
            }
            const fields = new Map(type.value.fields.map((field) => [field.name, field.type]));
            return Object.fromEntries(
                await Promise.all(
                    Object.entries(opts.value as Record<string, unknown>).map(async ([key, value]) => {
                        const fieldType = fields.get(key);
                        return [
                            key,
                            fieldType
                                ? await materializeValue({
                                      ...opts,
                                      type: fieldType,
                                      value,
                                  })
                                : value,
                        ];
                    })
                )
            );
        }
        case "union":
        case "result": {
            if (typeof opts.value !== "object" || opts.value === null) return opts.value;
            const tagged = opts.value as { kind: string; value: unknown };
            const payloadType =
                type.kind === "union"
                    ? type.value.variants.find((variant) => variant.name === tagged.kind)?.type
                    : tagged.kind === "ok"
                      ? type.value.okType
                      : tagged.kind === "err"
                        ? type.value.errType
                        : undefined;
            return payloadType
                ? {
                      kind: tagged.kind,
                      value: await materializeValue({ ...opts, type: payloadType, value: tagged.value }),
                  }
                : opts.value;
        }
        default:
            return opts.value;
    }
}

async function materializeActionParameters(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    backendAdapter: OntologyBackendAdapter;
    blobManager: BlobManager;
}): Promise<{
    parameters: Record<string, unknown>;
    attachmentIdMappings: OntologyAttachmentIdMapping[];
    attachmentUploads: OntologyAttachmentUpload[];
}> {
    const action = opts.ir.actionTypes.find((candidate) => candidate.name === opts.actionTypeName)!;
    const materialized = new Map<string, Promise<attachment>>();
    const attachmentIdMappings: OntologyAttachmentIdMapping[] = [];
    const attachmentUploads: OntologyAttachmentUpload[] = [];
    const parameters: Record<string, unknown> = {
        ...opts.parameters,
    };
    await Promise.all(
        action.parameters.map(async (parameter) => {
            parameters[parameter.name] = await materializeValue({
                ir: opts.ir,
                type: parameter.type,
                value: opts.parameters[parameter.name],
                backendAdapter: opts.backendAdapter,
                blobManager: opts.blobManager,
                materialized,
                mappings: attachmentIdMappings,
                uploads: attachmentUploads,
            });
        })
    );
    return {
        parameters,
        attachmentIdMappings,
        attachmentUploads,
    };
}

export async function prepareActionParameters(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    backendAdapter: OntologyBackendAdapter;
    blobManager?: BlobManager;
}): Promise<PreparedActionParameters> {
    const attachments = collectActionAttachments(opts.ir, opts.actionTypeName, opts.parameters);
    if (opts.backendAdapter.attachments?.materializeAttachment) {
        const blobManager = opts.blobManager;
        invariant(blobManager, "Missing required BlobManager for materializing attachments.");
        const materialized = await materializeActionParameters({
            ir: opts.ir,
            actionTypeName: opts.actionTypeName,
            parameters: opts.parameters,
            backendAdapter: opts.backendAdapter,
            blobManager,
        });
        return {
            parameters: materialized.parameters,
            attachmentUploads: materialized.attachmentUploads,
            attachmentIdMappings: materialized.attachmentIdMappings,
        };
    }
    return {
        parameters: opts.parameters,
        attachmentUploads: await collectActionAttachmentUploads({
            attachments,
            blobManager: opts.blobManager,
        }),
        attachmentIdMappings: [],
    };
}
