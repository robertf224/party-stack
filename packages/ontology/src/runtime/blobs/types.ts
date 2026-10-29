import type { BlobStorageService, ByteInput, ByteSource } from "@party-stack/ontology-storage/blobs";
import type { RuntimeAdapter } from "@party-stack/runtime";
import type { Scope } from "effect";

export interface PartialBlobMetadata {
    size?: number;
    type?: string;
    name?: string | null;
    dimensions?: BlobDimensions | null;
}

export interface BlobDimensions {
    width: number;
    height: number;
}

export interface BlobReadOptions {
    signal?: AbortSignal;
    meta?: Record<string, unknown>;
}

export type BlobMetadataField = keyof PartialBlobMetadata;

export interface BlobMetadataOptions extends BlobReadOptions {
    select?: readonly BlobMetadataField[];
}

export interface BlobRemoteSource {
    metadata?: (id: string, opts?: BlobMetadataOptions) => Promise<PartialBlobMetadata>;
    read: (id: string, opts?: BlobReadOptions) => Promise<ByteInput>;
}

export interface BlobManager {
    /** Native transactional storage for composition with a replica outbox. */
    readonly storage: Promise<BlobStorageService>;
    /** Resolves once blob metadata persistence has finished starting. */
    readonly ready: Promise<void>;
    stage: (id: string, blob: ByteInput) => Promise<void>;
    metadata: (id: string, opts?: BlobMetadataOptions) => Promise<PartialBlobMetadata & { id: string }>;
    source: (id: string, opts?: BlobReadOptions) => Promise<ByteSource>;
    read: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
    bindRemoteId: (localId: string, remoteId: string) => Promise<void>;
    cleanup: () => Promise<void>;
}

export interface BlobManagerOptions {
    runtime: RuntimeAdapter;
    scope?: Scope.Scope;
    remote: BlobRemoteSource;
    gcTime?: number;
}
