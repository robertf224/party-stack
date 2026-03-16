import { CollectionConfig } from "@tanstack/db";

export type OntologyCollectionOptions = Omit<
    CollectionConfig<Record<string, unknown>, string | number>,
    "getKey"
>;

export interface OntologyAdapter {
    name: string;
    getCollectionOptions: (objectType: string) => OntologyCollectionOptions;
    // TODO: improve this interface
    applyAction: (name: string, parameters: Record<string, unknown>) => Promise<void>;
    // TODO: install/destroy
    cleanup?: () => void | Promise<void>;
}
