import { invariant } from "@bobbyfidz/panic";
import type { BlobManager } from "@party-stack/blobs";
import { resolveType } from "../utils/types.js";
import type { OntologyAdapter } from "./OntologyAdapter.js";
import type {
    AttachmentTypeDef,
    ListTypeDef,
    MapTypeDef,
    OntologyIR,
    StructTypeDef,
    TypeDef,
} from "../ir/index.js";
import type { attachment } from "../utils/values.js";

interface MaterializeValueOptions {
    ir: OntologyIR;
    type: TypeDef;
    value: unknown;
}

interface ActionAttachment {
    attachment: attachment;
    target: AttachmentTypeDef;
}

export interface ActionAttachmentUpload extends ActionAttachment {
    blob: Blob;
}

export interface PreparedActionParameters {
    parameters: Record<string, unknown>;
    attachmentUploads: ActionAttachmentUpload[];
}

function isAttachment(value: unknown): value is attachment {
    return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function collectAttachment(
    opts: MaterializeValueOptions,
    type: AttachmentTypeDef,
    attachments: ActionAttachment[]
) {
    if (!isAttachment(opts.value)) return;
    attachments.push({
        attachment: opts.value,
        target: type,
    });
}

function collectList(opts: MaterializeValueOptions, type: ListTypeDef, attachments: ActionAttachment[]) {
    if (!Array.isArray(opts.value)) return;
    for (const value of opts.value) {
        collectValue(
            {
                ...opts,
                type: type.elementType,
                value,
            },
            attachments
        );
    }
}

function collectMap(opts: MaterializeValueOptions, type: MapTypeDef, attachments: ActionAttachment[]) {
    if (typeof opts.value !== "object" || opts.value === null) return;
    for (const value of Object.values(opts.value as Record<string, unknown>)) {
        collectValue(
            {
                ...opts,
                type: type.valueType,
                value,
            },
            attachments
        );
    }
}

function collectStruct(opts: MaterializeValueOptions, type: StructTypeDef, attachments: ActionAttachment[]) {
    if (typeof opts.value !== "object" || opts.value === null) return;
    const fieldsByName = new Map(type.fields.map((field) => [field.name, field.type]));
    for (const [key, value] of Object.entries(opts.value as Record<string, unknown>)) {
        const fieldType = fieldsByName.get(key);
        if (!fieldType) continue;
        collectValue(
            {
                ...opts,
                type: fieldType,
                value,
            },
            attachments
        );
    }
}

function collectValue(opts: MaterializeValueOptions, attachments: ActionAttachment[]): void {
    if (opts.value === undefined || opts.value === null) return;

    const type = resolveType(opts.ir, opts.type);
    switch (type.kind) {
        case "attachment":
            collectAttachment(opts, type.value, attachments);
            return;
        case "optional":
            collectValue(
                {
                    ...opts,
                    type: type.value.type,
                },
                attachments
            );
            return;
        case "list":
            collectList(opts, type.value, attachments);
            return;
        case "map":
            collectMap(opts, type.value, attachments);
            return;
        case "struct":
            collectStruct(opts, type.value, attachments);
            return;
        default:
            return;
    }
}

function collectActionAttachments(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
}): ActionAttachment[] {
    const action = opts.ir.actionTypes.find((candidate) => candidate.name === opts.actionTypeName)!;
    const attachments: ActionAttachment[] = [];
    for (const parameter of action.parameters) {
        collectValue(
            {
                ir: opts.ir,
                type: parameter.type,
                value: opts.parameters[parameter.name],
            },
            attachments
        );
    }
    return [...new Map(attachments.map((entry) => [entry.attachment.id, entry])).values()];
}

async function collectActionAttachmentUploads(opts: {
    attachments: ActionAttachment[];
    blobManager?: BlobManager;
}): Promise<ActionAttachmentUpload[]> {
    if (opts.attachments.length === 0) return [];
    const blobManager = opts.blobManager;
    invariant(blobManager, "Missing required BlobManager for collecting attachment uploads.");
    return Promise.all(
        opts.attachments.map(async (entry) => ({
            ...entry,
            blob: await blobManager.blob(entry.attachment.id),
        }))
    );
}

async function materializeActionAttachments(opts: {
    adapter: OntologyAdapter;
    blobManager?: BlobManager;
    attachments: ActionAttachment[];
}): Promise<void> {
    const materializeAttachment = opts.adapter.attachments?.materializeAttachment;
    if (!materializeAttachment || opts.attachments.length === 0) return;
    const blobManager = opts.blobManager;
    invariant(blobManager, "Missing required BlobManager for materializing attachments.");
    await Promise.all(
        opts.attachments.map(({ attachment, target }) =>
            blobManager.withUploadTracking(attachment.id, (blob) =>
                materializeAttachment(attachment, blob, { target })
            )
        )
    );
}

export async function prepareActionParameters(opts: {
    ir: OntologyIR;
    actionTypeName: string;
    parameters: Record<string, unknown>;
    adapter: OntologyAdapter;
    blobManager?: BlobManager;
}): Promise<PreparedActionParameters> {
    const attachments = collectActionAttachments({
        ir: opts.ir,
        actionTypeName: opts.actionTypeName,
        parameters: opts.parameters,
    });
    if (opts.adapter.attachments?.materializeAttachment) {
        await materializeActionAttachments({
            adapter: opts.adapter,
            blobManager: opts.blobManager,
            attachments,
        });
        return {
            parameters: opts.parameters,
            attachmentUploads: [],
        };
    }
    return {
        parameters: opts.parameters,
        attachmentUploads: await collectActionAttachmentUploads({
            attachments,
            blobManager: opts.blobManager,
        }),
    };
}
