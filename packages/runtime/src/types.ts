import type { BrowserAuthenticationError } from "./BrowserAuthenticationError.js";
import type { RuntimeError } from "./Runtime.js";
import type { OntologyStorageError } from "@party-stack/ontology-storage";
import type { BlobBytesService } from "@party-stack/ontology-storage/blobs";
import type { EncryptionError, EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";
import type { TablesService } from "@party-stack/ontology-storage/tables";
import type { Effect, Scope, Stream } from "effect";

export interface NetworkConnectivity {
    readonly online: Effect.Effect<boolean>;
    /** Includes the current state; intermediate transitions may be coalesced. */
    readonly changes: Stream.Stream<boolean>;
}

export type BrowserAuthenticationPresentation = "popup" | "redirect";

export interface BrowserAuthenticationSession {
    open(authorizationUrl: string): Effect.Effect<{ callbackUrl: string }, BrowserAuthenticationError>;
}

export interface BrowserAuthentication {
    start(options: {
        redirectUrl: string;
        presentation?: BrowserAuthenticationPresentation;
    }): Effect.Effect<BrowserAuthenticationSession, BrowserAuthenticationError, Scope.Scope>;
}

/** Platform-acquired capabilities; Runtime.make assembles the RuntimeService. */
export interface RuntimeOptions {
    blobBytes: BlobBytesService;
    connectivity?: NetworkConnectivity;
    browserAuthentication?: BrowserAuthentication;
    encryptionKeyring?: EncryptionKeyringService;
    /** Acquired by the platform layer in its scope, including explicit memory tables. */
    tables: TablesService;
    destroy?: Effect.Effect<void, RuntimeError>;
}

export type RuntimeAcquisitionError = RuntimeError | OntologyStorageError | EncryptionError;
