export interface OntologyAttachmentIdMapping {
    /** The opaque attachment ID used before the backend canonicalized it. */
    localId: string;
    /** The canonical attachment ID returned by the backend. */
    remoteId: string;
}

export type OntologyApplyActionResult<Return = unknown> = {
    receipt?: import("@party-stack/ontology-backend").ActionReceipt;
    /**
     * Mappings for uploaded attachments whose canonical backend IDs differ from
     * the local IDs supplied in `ActionRequest.attachmentUploads`.
     */
    attachmentIdMappings?: OntologyAttachmentIdMapping[];
} & (undefined extends Return ? { result?: Return } : { result: Return });
