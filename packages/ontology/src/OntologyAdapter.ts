import { SyncConfig } from "@tanstack/db";

export interface OntologyAdapter {
    name: string;
    getSyncConfig: (objectType: string) => SyncConfig;
    // TODO: actions
    // TODO: install/destroy
}
