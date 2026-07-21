import type { PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

export interface BlobBytesStore {
    write(id: string, blob: Blob): Promise<void>;
    read(id: string): Promise<Blob>;
    delete(id: string): Promise<void>;
    list(): Promise<string[]>;
}

export interface LockOptions {
    signal?: AbortSignal;
}

export interface LockManager {
    request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
    request<T>(name: string, options: LockOptions, callback: () => T | PromiseLike<T>): Promise<T>;
}

export type { PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

export interface RuntimeServices {
    blobBytes: BlobBytesStore;
    locks?: LockManager;
    persistence?: PersistenceAdapter;
    cleanup?: () => void | Promise<void>;
}

export type RuntimeServicesPreset = (
    owner: string,
    namespace: string
) => RuntimeServices | Promise<RuntimeServices>;
