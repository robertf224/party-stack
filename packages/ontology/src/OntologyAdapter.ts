import { CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface OntologyAdapter {
    name: string;
    getCollectionOptions: (objectType: string) => OntologyCollectionOptions;
    // TODO: actions
    // TODO: install/destroy
}
