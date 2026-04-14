import * as v from "@party-stack/schema/values";
import type { Collection, CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface ApplyActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
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
    generateAttachmentId?: (
        blob: Blob,
        opts: {
            target?: {
                objectType: string;
                property: string;
            };
        }
    ) => string;
    createAttachment: (
        blob: Blob,
        opts: {
            id?: string;
            target?: {
                objectType: string;
                property: string;
            };
        }
    ) => Promise<v.attachment>;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}
