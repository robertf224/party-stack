import type {
    PartialBlobMetadata,
    BlobReadOptions,
    BlobMetadataOptions,
} from "@party-stack/ontology-replica/attachments";
import type { BlobStorageService, ByteInput, ByteSource } from "@party-stack/ontology-storage/blobs";
import type { RuntimeService } from "@party-stack/runtime";
import type { Scope } from "effect";
export type {
    PartialBlobMetadata,
    BlobDimensions,
    BlobReadOptions,
    BlobMetadataField,
    BlobMetadataOptions,
} from "@party-stack/ontology-replica/attachments";

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
    runtime: RuntimeService;
    scope: Scope.Scope;
    remote: BlobRemoteSource;
    gcTime?: number;
}
