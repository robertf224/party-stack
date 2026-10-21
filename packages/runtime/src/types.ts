import type { Coordination } from "@party-stack/coordination";

export interface BlobBytesStore {
    write(id: string, blob: Blob): Promise<void>;
    /** Reject with BlobBytesNotFoundError for a missing key; preserve other IO failures. */
    read(id: string): Promise<Blob>;
    delete(id: string): Promise<void>;
}

export interface NetworkConnectivity {
    readonly isConnected: boolean;
    subscribe(callback: (isConnected: boolean) => void): () => void;
}

export interface SecretStore {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
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

export interface RuntimeAdapter {
    readonly owner: string;
    readonly namespace: string;
    blobBytes: BlobBytesStore;
    coordination: Coordination;
    connectivity?: NetworkConnectivity;
    browserAuthentication?: BrowserAuthentication;
    secrets?: SecretStore;
    encryptionKeyring?: import("effect").Effect.Effect<
        import("@party-stack/ontology-storage/encrypted").EncryptionKeyringService,
        import("@party-stack/ontology-storage/encrypted").EncryptionError,
        import("effect").Scope.Scope
    >;
    /** Owned storage acquired once in the runtime's Effect scope. */
    tables?: import("effect").Effect.Effect<
        import("@party-stack/ontology-storage/tables").TablesService,
        import("@party-stack/ontology-storage").OntologyStorageError,
        import("effect").Scope.Scope
    >;
    storageNotifications?: { publish(): void; subscribe(listener: () => void): () => void };
    actorLiveness?: {
        acquire(owner: string): import("effect").Effect.Effect<void, unknown, import("effect").Scope.Scope>;
        isAlive(owner: string): import("effect").Effect.Effect<boolean, unknown>;
    };
    cleanup?: () => void | Promise<void>;
    destroy?: () => void | Promise<void>;
}

export type RuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => RuntimeAdapter | Promise<RuntimeAdapter>;
