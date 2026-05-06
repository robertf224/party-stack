import type { BlobEvictionStrategy } from "./gc/types.js";

export type BlobState = "staging" | "staged" | "uploading" | "persisted" | "cached" | "failed";

export interface BlobRef {
    id: string;
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
    markPersisted: (id: string) => Promise<BlobRef>;
    markFailed: (id: string, error?: unknown) => Promise<BlobRef>;
    purge: (id: string) => Promise<void>;
    reconcile: () => Promise<void>;
}

export type BlobStoreProvider = (name: string) => BlobStore;

export interface BlobRemoteMetadata {
    id: string;
    size: number;
    type: string;
    name: string;
}

export interface BlobRemoteSource {
    metadata: (id: string) => Promise<BlobRemoteMetadata>;
    blob: (id: string) => Promise<Blob>;
}

export interface BlobManager {
    stage: (id: string, blob: Blob | File) => Promise<BlobRef>;
    metadata: (id: string) => Promise<BlobRemoteMetadata>;
    blob: (id: string) => Promise<Blob>;
    withUploadTracking: (id: string, uploadFn: (blob: Blob) => Promise<void>) => Promise<void>;
    retain: (id: string) => void;
    release: (id: string) => void;
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
}
