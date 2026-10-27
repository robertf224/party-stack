import type { BackendError, OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { CollectionConfig, UtilsRecord } from "@tanstack/db";
import type { Effect, Scope } from "effect";

export interface OntologyCollectionUtils extends UtilsRecord {
    /** Fetch and atomically replace the source snapshot, when supported by the adapter. */
    refresh?: () => Promise<void>;
}

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number, never, OntologyCollectionUtils>,
    "getKey"
>;

export type OntologyAttachmentUpload = import("@party-stack/ontology-backend").AttachmentUpload;

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
     * the local IDs supplied in `ActionRequest.attachmentUploads`.
     */
    attachmentIdMappings?: OntologyAttachmentIdMapping[];
}

export interface OntologyBackendAdapter {
    name: string;
    /** Acquire all backend resources and capabilities in the caller's Scope. */
    open: (
        context: Record<string, unknown>
    ) => Effect.Effect<OntologyBackendService, BackendError, Scope.Scope>;
}

export type OntologyBackendAdapterProvider<
    Context extends Record<string, unknown> = Record<string, unknown>,
> = (ir: OntologyIR, context: Context) => OntologyBackendAdapter | Promise<OntologyBackendAdapter>;
