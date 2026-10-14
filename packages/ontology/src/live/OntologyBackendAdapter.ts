import * as v from "../utils/values.js";
import type { AttachmentTypeDef, OntologyIR } from "../ir/index.js";
import type { Uncertain } from "../utils/uncertain.js";
import type { ValidationIssue } from "../utils/validation.js";
import type { PartialAttachmentMetadata } from "./attachments/types.js";
import type { Collection, CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface OntologyAttachmentUpload {
    /**
     * The attachment referenced by the prepared action parameters. Its ID is an
     * opaque local handle and is not guaranteed to be valid for the backend.
     */
    attachment: v.attachment;
    blob: Blob;
    target?: AttachmentTypeDef;
}

export interface OntologyAttachmentIdMapping {
    /** The opaque attachment ID used before the backend canonicalized it. */
    localId: string;
    /** The canonical attachment ID returned by the backend. */
    remoteId: string;
}

export interface OntologyApplyActionResult {
    /**
     * Mappings for uploaded attachments whose canonical backend IDs differ from
     * the local IDs supplied in `ApplyActionLiveOpts.attachmentUploads`.
     */
    attachmentIdMappings?: OntologyAttachmentIdMapping[];
}

export interface ApplyActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
    context?: Record<string, unknown>;
    /**
     * Attachments that must be uploaded as part of action execution. Adapters
     * must treat their IDs as opaque local handles, substitute any backend IDs or
     * references required by the action invocation, and return an ID mapping for
     * every upload whose canonical backend ID differs.
     */
    attachmentUploads?: OntologyAttachmentUpload[];
    idempotencyKey?: string;
}

export interface ValidateActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
    context?: Record<string, unknown>;
}

export interface ValidateActionDraftLiveOpts extends ValidateActionLiveOpts {
    knownParameters: readonly string[];
}

export interface RunQueryLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
    context?: Record<string, unknown>;
}

export interface OntologyAttachmentsAdapter {
    /**
     * Generates a preferred ID for an attachment created directly against this adapter.
     *
     * This is a hint, not an invariant. Attachments can arrive with IDs generated elsewhere,
     * so adapters must accept IDs downstream that were not produced by this function.
     */
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
    /**
     * Materializes an attachment in the backend.
     *
     * The incoming attachment ID is opaque and may not be valid for this backend. When
     * the backend assigns or requires another ID, return an attachment containing that
     * canonical ID so the caller can rewrite parameters and bind the resulting mapping.
     */
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
    /**
     * Whether this adapter participates in long-lived synchronization.
     *
     * Defaults to true. Non-live adapters support confirmed request/response
     * operations but cannot safely back optimistic actions.
     */
    live?: boolean;
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
    ) => Promise<Uncertain<v.Result<void, readonly ValidationIssue[]>>>;
    validateActionDraft?: (
        name: string,
        parameters: Record<string, unknown>,
        live: ValidateActionDraftLiveOpts
    ) => Promise<Uncertain<v.Result<void, readonly ValidationIssue[]>>>;
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
