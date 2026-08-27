import type { RuntimeAdapter } from "@party-stack/runtime";
import type { Collection } from "@tanstack/db";

export type BlobState = "staged" | "persisted" | "cached";

export type BlobOperation =
    | {
          kind: "stage" | "cache" | "purge";
          status: "pending";
          operationId: string;
      }
    | {
          kind: "stage" | "cache" | "purge";
          status: "failed";
          operationId: string;
          error: string;
      };

export interface PartialBlobMetadata {
    size?: number;
    type?: string;
    name?: string | null;
    dimensions?: BlobDimensions | null;
}

export interface BlobMetadataRecord extends PartialBlobMetadata {
    id: string;
    remoteId?: string;
    state?: BlobState;
    operation?: BlobOperation;
    lastAccessedAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface BlobRef {
    id: string;
    type: string;
    size: number;
    name?: string;
}

export interface BlobDimensions {
    width: number;
    height: number;
}

export interface BlobReadOptions {
    meta?: Record<string, unknown>;
}

export type BlobMetadataField = keyof PartialBlobMetadata;

export interface BlobMetadataOptions extends BlobReadOptions {
    select?: readonly BlobMetadataField[];
}

export interface BlobRemoteSource {
    metadata?: (id: string, opts?: BlobMetadataOptions) => Promise<PartialBlobMetadata>;
    read: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
}

export interface BlobManager {
    readonly collection: Collection<BlobMetadataRecord, string>;
    /** Resolves once blob metadata persistence has finished starting. */
    readonly ready: Promise<void>;
    stage: (id: string, blob: Blob | File) => Promise<void>;
    metadata: (id: string, opts?: BlobMetadataOptions) => Promise<PartialBlobMetadata & { id: string }>;
    read: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
    bindRemoteId: (localId: string, remoteId: string) => Promise<void>;
    cleanup: () => Promise<void>;
}

export interface BlobManagerOptions {
    runtime: RuntimeAdapter;
    remote: BlobRemoteSource;
    gcTime?: number;
}
