import type { Coordination } from "@party-stack/coordination";
import type { PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

export interface BlobBytesStore {
    write(id: string, blob: Blob): Promise<void>;
    read(id: string): Promise<Blob>;
    delete(id: string): Promise<void>;
}

export interface NetworkConnectivity {
    readonly isConnected: boolean;
    subscribe(callback: (isConnected: boolean) => void): () => void;
}

export type { PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

export interface RuntimeAdapter {
    readonly owner: string;
    readonly namespace: string;
    blobBytes: BlobBytesStore;
    coordination: Coordination;
    connectivity?: NetworkConnectivity;
    persistence?: PersistenceAdapter;
    cleanup?: () => void | Promise<void>;
}

export type RuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => RuntimeAdapter | Promise<RuntimeAdapter>;
