import * as v from "@party-stack/ontology-spec/values";
import type { PartialAttachmentMetadata } from "./attachments/types.js";
import type { AttachmentTypeDef, OntologyIR } from "@party-stack/ontology-spec";
import type { Uncertain } from "@party-stack/ontology-spec/utils";
import type { ValidationIssue } from "@party-stack/ontology-spec/utils";
import type { Collection, CollectionConfig, UtilsRecord } from "@tanstack/db";

export interface OntologyCollectionUtils extends UtilsRecord {
    /** Fetch and atomically replace the source snapshot, when supported by the adapter. */
    refresh?: () => Promise<void>;
}

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number, never, OntologyCollectionUtils>,
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
    receipt?: import("@party-stack/ontology-backend").ActionReceipt;
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
    getAttachmentContent: (attachment: v.attachment, options?: { signal?: AbortSignal }) => Promise<Blob>;
    getAttachmentMetadata?: (
        attachment: v.attachment,
        selection: readonly (keyof PartialAttachmentMetadata)[],
        options?: { signal?: AbortSignal }
    ) => Promise<PartialAttachmentMetadata>;
}

export interface OntologyBackendAdapter {
    name: string;
    /** Acquire the native backend in the caller's Effect scope. */
    open: (
        context: Record<string, unknown>
    ) => import("effect").Effect.Effect<
        import("@party-stack/ontology-backend").OntologyBackendService,
        import("@party-stack/ontology-backend").BackendError,
        import("effect").Scope.Scope
    >;
    validateAction?: (
        name: string,
        parameters: Record<string, unknown>,
        live: ValidateActionLiveOpts
    ) => import("effect").Effect.Effect<
        Uncertain<v.Result<void, readonly ValidationIssue[]>>,
        import("@party-stack/ontology-backend").BackendError
    >;
    validateActionDraft?: (
        name: string,
        parameters: Record<string, unknown>,
        live: ValidateActionDraftLiveOpts
    ) => import("effect").Effect.Effect<
        Uncertain<v.Result<void, readonly ValidationIssue[]>>,
        import("@party-stack/ontology-backend").BackendError
    >;
    attachments?: OntologyAttachmentsAdapter;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}

export type OntologyBackendAdapterProvider<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (ir: OntologyIR, context: Context) => OntologyBackendAdapter | Promise<OntologyBackendAdapter>;
