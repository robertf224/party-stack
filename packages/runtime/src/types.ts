import type { Coordination } from "@party-stack/coordination";
import type { PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

export interface BlobBytesStore {
    write(id: string, blob: Blob): Promise<void>;
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

export type { PersistenceAdapter } from "@tanstack/db-sqlite-persistence-core";

export interface RuntimeAdapter {
    readonly owner: string;
    readonly namespace: string;
    blobBytes: BlobBytesStore;
    coordination: Coordination;
    connectivity?: NetworkConnectivity;
    browserAuthentication?: BrowserAuthentication;
    secrets?: SecretStore;
    persistence?: PersistenceAdapter;
    cleanup?: () => void | Promise<void>;
    destroy?: () => void | Promise<void>;
}

export type RuntimeAdapterProvider = (
    owner: string,
    namespace: string
) => RuntimeAdapter | Promise<RuntimeAdapter>;
