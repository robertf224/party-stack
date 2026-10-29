import type { RuntimeError } from "./Runtime.js";
import type { OntologyStorageError } from "@party-stack/ontology-storage";
import type { BlobBytesService } from "@party-stack/ontology-storage/blobs";
import type { EncryptionError, EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { Effect, Scope } from "effect";

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
export interface RuntimeOptions {
    blobBytes: BlobBytesService;
    connectivity?: NetworkConnectivity;
    browserAuthentication?: BrowserAuthentication;
    encryptionKeyring?: Effect.Effect<EncryptionKeyringService, EncryptionError, Scope.Scope>;
    /** Owned storage acquired once in the runtime's Effect scope. */
    tables?: Effect.Effect<TablesService, OntologyStorageError, Scope.Scope>;
    destroy?: Effect.Effect<void, RuntimeError>;
}

export type RuntimeAcquisitionError = RuntimeError | OntologyStorageError | EncryptionError;
