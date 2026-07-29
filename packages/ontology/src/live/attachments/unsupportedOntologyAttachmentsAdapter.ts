import type { OntologyAttachmentsAdapter } from "../OntologyBackendAdapter.js";

export const unsupportedOntologyAttachmentsAdapter: OntologyAttachmentsAdapter = {
    getAttachmentContent: (attachment) =>
        Promise.reject(new Error(`Ontology adapter cannot read attachment content for "${attachment.id}".`)),
    getAttachmentMetadata: (attachment) =>
        Promise.reject(new Error(`Ontology adapter cannot read attachment metadata for "${attachment.id}".`)),
};
