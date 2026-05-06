import * as v from "../utils/values.js";
import type { AttachmentTypeDef } from "../ir/index.js";
import type { Collection, CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface ApplyActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
}

export interface OntologyAttachmentsAdapter {
    generateAttachmentId: (
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
    ) => Promise<void>;
    getAttachmentContent: (attachment: v.attachment) => Promise<Blob>;
    getAttachmentMetadata: (attachment: v.attachment) => Promise<Required<v.attachment>>;
}

// TODO: maybe put collections/actions/cleanup/etc. behind provider

export interface OntologyAdapter {
    name: string;
    getCollectionOptions: (objectType: string) => OntologyCollectionOptions;
    applyAction: (
        name: string,
        parameters: Record<string, unknown>,
        live: ApplyActionLiveOpts
    ) => Promise<void>;
    attachments?: OntologyAttachmentsAdapter;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}
