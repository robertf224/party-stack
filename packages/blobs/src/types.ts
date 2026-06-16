import type { BlobEvictionStrategy } from "./gc/types.js";

export type BlobState = "staging" | "staged" | "uploading" | "persisted" | "cached" | "failed";

export interface BlobRef {
    id: string;
    remoteId?: string;
    type: string;
    size: number;
    name?: string;
    state: BlobState;
    lastAccessedAt?: number;
    createdAt: number;
    updatedAt: number;
    error?: string;
}

export interface BlobBytesAdapter {
    write: (id: string, blob: Blob) => Promise<void>;
    read: (id: string) => Promise<Blob>;
    delete: (id: string) => Promise<void>;
    list?: () => Promise<string[]>;
}

export interface BlobMetadataAdapter {
    put: (ref: BlobRef) => Promise<void>;
    get: (id: string) => Promise<BlobRef | undefined>;
    getByRemoteId: (remoteId: string) => Promise<BlobRef | undefined>;
    delete: (id: string) => Promise<void>;
    list: (opts?: { state?: BlobState }) => Promise<BlobRef[]>;
}

export type BlobBytesAdapterProvider = (name: string) => BlobBytesAdapter;
export type BlobMetadataAdapterProvider = (name: string) => BlobMetadataAdapter;

export interface BlobStore {
    stage: (id: string, blob: Blob | File) => Promise<BlobRef>;
    cache: (id: string, blob: Blob | File) => Promise<BlobRef>;
    get: (id: string) => Promise<BlobRef | undefined>;
    read: (id: string) => Promise<Blob>;
    list: (opts?: { state?: BlobState }) => Promise<BlobRef[]>;
    markUploading: (id: string) => Promise<BlobRef>;
    markUploaded: (id: string, opts?: { remoteId?: string }) => Promise<BlobRef>;
    markFailed: (id: string, error?: unknown) => Promise<BlobRef>;
    purge: (id: string) => Promise<void>;
    reconcile: () => Promise<void>;
    withUploadLock?: <T>(id: string, callback: () => Promise<T>) => Promise<T>;
}

export type BlobStoreProvider = (name: string) => BlobStore;

export type BlobRetentionProvider = () =>
    | Iterable<string>
    | Promise<Iterable<string>>;

export interface BlobRemoteMetadata {
    id: string;
    size: number;
    type: string;
    name: string;
}

export interface BlobReadOptions {
    meta?: Record<string, unknown>;
}

export interface BlobRemoteSource {
    metadata: (id: string, opts?: BlobReadOptions) => Promise<BlobRemoteMetadata>;
    blob: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
}

export interface BlobManager {
    stage: (id: string, blob: Blob | File) => Promise<BlobRef>;
    metadata: (id: string, opts?: BlobReadOptions) => Promise<BlobRemoteMetadata>;
    blob: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
    withUploadTracking: (
        id: string,
        uploadFn: (blob: Blob) => Promise<{ remoteId?: string } | void>
    ) => Promise<void>;
    markUploaded: (id: string, opts?: { remoteId?: string }) => Promise<BlobRef>;
}

export interface BlobManagerOptions {
    store: BlobStore;
    remote: BlobRemoteSource;
    now?: () => number;
    gcScheduler?: (run: () => void) => void;
    gcReleaseBufferSize?: number;
    cacheMaxAgeMs?: number;
    maxCacheBytes?: number;
    evictionStrategy?: BlobEvictionStrategy;
    retentionProviders?: BlobRetentionProvider[];
}
