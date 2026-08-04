import * as v from "../utils/values.js";
import type { AttachmentTypeDef, OntologyIR } from "../ir/index.js";
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
    getAttachmentMetadata: (attachment: v.attachment) => Promise<OntologyAttachmentMetadata>;
}

/**
 * Attachment metadata returned by LiveOntology / backend adapters.
 * Ordinary attachments remain compatible; media may include image dimensions.
 */
export type OntologyAttachmentMetadata = v.attachment & {
    size: number;
    type: string;
    name?: string;
    width?: number;
    height?: number;
    /** Which Foundry (or other) storage surface produced this attachment. */
    provider?: "attachment" | "media";
};

export interface OntologyLinkedObject {
    objectType: string;
    primaryKey: string | number;
    properties: Record<string, unknown>;
}

export interface OntologyLinkPage {
    objects: OntologyLinkedObject[];
    /** Opaque pagination token from the backend. */
    nextPageToken?: string;
}

export type OntologyLinkRef = { sideName: string } | { id: string };

export interface OntologyListLinksOpts {
    objectType: string;
    primaryKey: string | number;
    link: OntologyLinkRef;
    pageSize?: number;
    pageToken?: string;
    select?: string[];
}

export interface OntologyGetLinkOpts {
    objectType: string;
    primaryKey: string | number;
    link: OntologyLinkRef;
    /** When known, enables direct linked-object fetch on backends that support it. */
    linkedPrimaryKey?: string | number;
    select?: string[];
}

/**
 * Optional backend capability for link traversal when the IR cannot satisfy the
 * request locally (e.g. non-FK Foundry links).
 */
export interface OntologyLinksAdapter {
    list: (opts: OntologyListLinksOpts) => Promise<OntologyLinkPage>;
    get: (opts: OntologyGetLinkOpts) => Promise<OntologyLinkedObject | undefined>;
}

export interface OntologyBackendAdapter {
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
    /** Backend link traversal used when local FK resolution is not possible. */
    links?: OntologyLinksAdapter;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}

export type OntologyBackendAdapterProvider<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (ir: OntologyIR, context: Context) => OntologyBackendAdapter | Promise<OntologyBackendAdapter>;
