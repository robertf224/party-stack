import type { Collection, CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface ApplyActionLiveOpts {
    objects: Record<string, Collection<Record<string, unknown>>>;
}

export interface OntologyAdapter {
    name: string;
    getCollectionOptions: (objectType: string) => OntologyCollectionOptions;
    applyAction: (
        name: string,
        parameters: Record<string, unknown>,
        live: ApplyActionLiveOpts
    ) => Promise<void>;
    cleanup?: () => void | Promise<void>;
    // TODO: install/destroy
}
