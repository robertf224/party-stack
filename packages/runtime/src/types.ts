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
    get(key: string): import("effect").Effect.Effect<string | undefined, import("./Runtime.js").RuntimeError>;
    set(
        key: string,
        value: string
    ): import("effect").Effect.Effect<void, import("./Runtime.js").RuntimeError>;
    delete(key: string): import("effect").Effect.Effect<void, import("./Runtime.js").RuntimeError>;
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
    destroy?: () => void | Promise<void>;
    /** Acquire the sole persistent replica host until the calling Scope closes. */
    acquireHost?: import("effect").Effect.Effect<
        void,
        import("./Runtime.js").RuntimeError,
        import("effect").Scope.Scope
    >;
}

export type RuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => import("effect").Effect.Effect<
    import("./Runtime.js").RuntimeService,
    RuntimeAcquisitionError,
    import("effect").Scope.Scope
>;

export type RuntimeAcquisitionError =
    | import("./Runtime.js").RuntimeError
    | import("@party-stack/ontology-storage").OntologyStorageError
    | import("@party-stack/ontology-storage/encrypted").EncryptionError;
