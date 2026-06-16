import * as v from "../utils/values.js";
import type { AttachmentTypeDef } from "../ir/index.js";
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
    materializeAttachment?: (
        attachment: v.attachment,
        blob: Blob,
        opts: {
            target?: AttachmentTypeDef;
        }
    ) => Promise<OntologyAttachmentIdMapping | void>;
    getAttachmentContent: (attachment: v.attachment) => Promise<Blob>;
    getAttachmentMetadata: (attachment: v.attachment) => Promise<v.attachment & { size: number; type: string; name: string }>;
}

// TODO: maybe put collections/actions/cleanup/etc. behind provider

export interface OntologyAdapter {
    name: string;
    getCollectionOptions: (objectType: string) => OntologyCollectionOptions;
    applyAction: (
        name: string,
        parameters: Record<string, unknown>,
        live: ApplyActionLiveOpts
    ) => Promise<OntologyApplyActionResult | void>;
    runQueryFunction: (
        name: string,
        parameters: Record<string, unknown>,
        live: RunQueryLiveOpts
    ) => Promise<unknown>;
    attachments?: OntologyAttachmentsAdapter;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}
