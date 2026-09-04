import * as v from "../utils/values.js";
import type { AttachmentTypeDef, OntologyIR } from "../ir/index.js";
import type { Uncertain } from "../utils/uncertain.js";
import type { PartialAttachmentMetadata } from "./attachments/types.js";
import type { Collection, CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface OntologyAttachmentUpload {
    attachment: v.attachment;
    blob: Blob;
    target?: AttachmentTypeDef;
}

export interface OntologyAttachmentIdMapping {
    localId: string;
    remoteId: string;
}

export interface OntologyApplyActionResult {
    attachmentIdMappings?: OntologyAttachmentIdMapping[];
}

export interface ApplyActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
    context?: Record<string, unknown>;
    attachmentUploads?: OntologyAttachmentUpload[];
    idempotencyKey?: string;
}

export interface ValidateActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
    context?: Record<string, unknown>;
}

export interface RunQueryLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
    context?: Record<string, unknown>;
}

export interface OntologyAttachmentsAdapter {
    generateAttachmentId?: (
        blob: Blob,
        opts: {
            target?: AttachmentTypeDef;
        }
    ) => Promise<string> | string;
    canMaterializeAttachment?: (
        attachment: v.attachment,
        opts: {
            target?: AttachmentTypeDef;
        }
    ) => boolean;
    materializeAttachment?: (
        attachment: v.attachment,
        blob: Blob,
        opts: {
            target?: AttachmentTypeDef;
        }
    ) => Promise<v.attachment | void>;
    getAttachmentContent: (attachment: v.attachment) => Promise<Blob>;
    getAttachmentMetadata?: (
        attachment: v.attachment,
        selection: readonly (keyof PartialAttachmentMetadata)[]
    ) => Promise<PartialAttachmentMetadata>;
}

export interface OntologyBackendAdapter {
    name: string;
    getCollectionOptions: (objectType: string) => OntologyCollectionOptions;
    applyAction: (
        name: string,
        parameters: Record<string, unknown>,
        live: ApplyActionLiveOpts
    ) => Promise<OntologyApplyActionResult | void>;
    validateAction?: (
        name: string,
        parameters: Record<string, unknown>,
        live: ValidateActionLiveOpts
    ) => Promise<Uncertain<v.Result<void, string[]>>>;
    validateActionDraft?: (
        name: string,
        parameters: Record<string, unknown>,
        live: ValidateActionLiveOpts
    ) => Promise<Uncertain<v.Result<void, string[]>>>;
    runQueryFunction: (
        name: string,
        parameters: Record<string, unknown>,
        live: RunQueryLiveOpts
    ) => Promise<unknown>;
    attachments?: OntologyAttachmentsAdapter;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}

export type OntologyBackendAdapterProvider<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (ir: OntologyIR, context: Context) => OntologyBackendAdapter | Promise<OntologyBackendAdapter>;
