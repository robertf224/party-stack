import type { RuntimeService, RuntimeError } from "./Runtime.js";
import type { OntologyStorageError } from "@party-stack/ontology-storage";
import type { ByteInput } from "@party-stack/ontology-storage/blobs";
import type { EncryptionError, EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { Effect, Scope } from "effect";

export interface BlobBytesStore {
    write(id: string, bytes: ByteInput, signal?: AbortSignal): Promise<void>;
    /** Reject with BlobBytesNotFoundError for a missing key; preserve other IO failures. */
    read(id: string): Promise<ByteInput>;
    delete(id: string): Promise<void>;
}

export interface NetworkConnectivity {
    readonly isConnected: boolean;
    subscribe(callback: (isConnected: boolean) => void): () => void;
}

export type BrowserAuthenticationPresentation = "popup" | "redirect";

export interface BrowserAuthenticationSession {
    open(authorizationUrl: string): Promise<{ callbackUrl: string }>;
    close(): void | Promise<void>;
}

export interface BrowserAuthentication {
    start(options: {
        redirectUrl: string;
        presentation?: BrowserAuthenticationPresentation;
    }): BrowserAuthenticationSession;
}

/** Platform construction hooks; Runtime.make acquires the scoped RuntimeService. */
export interface RuntimeAdapter {
    readonly owner: string;
    readonly namespace: string;
    blobBytes: BlobBytesStore;
    connectivity?: NetworkConnectivity;
    browserAuthentication?: BrowserAuthentication;
    encryptionKeyring?: Effect.Effect<EncryptionKeyringService, EncryptionError, Scope.Scope>;
    /** Owned storage acquired once in the runtime's Effect scope. */
    tables?: Effect.Effect<TablesService, OntologyStorageError, Scope.Scope>;
    storageNotifications?: { publish(): void; subscribe(listener: () => void): () => void };
    actorLiveness?: {
        acquire(owner: string): Effect.Effect<void, unknown, Scope.Scope>;
        isAlive(owner: string): Effect.Effect<boolean, unknown>;
    };
    destroy?: () => void | Promise<void>;
    /** Acquire the sole persistent replica host until the calling Scope closes. */
    acquireHost?: Effect.Effect<void, RuntimeError, Scope.Scope>;
}

/** Scoped service factory. The historical name refers to its platform adapter. */
export type RuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => Effect.Effect<RuntimeService, RuntimeAcquisitionError, Scope.Scope>;

export type RuntimeAcquisitionError = RuntimeError | OntologyStorageError | EncryptionError;
