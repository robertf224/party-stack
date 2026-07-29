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

export interface BlobRef {
    id: string;
    remoteId?: string;
    type: string;
    size: number;
    name?: string;
    state?: BlobState;
    operation?: BlobOperation;
    lastAccessedAt?: number;
    createdAt: number;
    updatedAt: number;
}

export interface BlobRemoteMetadata {
    id: string;
    size: number;
    type: string;
    name?: string;
}

export interface BlobReadOptions {
    meta?: Record<string, unknown>;
}

export interface BlobRemoteSource {
    metadata: (id: string, opts?: BlobReadOptions) => Promise<BlobRemoteMetadata>;
    read: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
}

export interface BlobManager {
    readonly collection: Collection<BlobRef, string>;
    stage: (id: string, blob: Blob | File) => Promise<BlobRef>;
    metadata: (id: string, opts?: BlobReadOptions) => Promise<BlobRemoteMetadata>;
    read: (id: string, opts?: BlobReadOptions) => Promise<Blob>;
    bindRemoteId: (localId: string, remoteId: string) => Promise<BlobRef>;
    cleanup: () => Promise<void>;
}

export interface BlobManagerOptions {
    runtime: RuntimeAdapter;
    remote: BlobRemoteSource;
    gcTime?: number;
}
