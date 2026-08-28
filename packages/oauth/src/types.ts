import type { BrowserAuthenticationPresentation, RuntimeAdapter } from "@party-stack/runtime";

export interface OAuthAuthorizationServer {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
}

export interface OAuthSession {
    userId: string;
    expiration?: {
        expiresAt: number;
        refreshable: boolean;
    };
}

export interface PublicOAuthSignInOptions {
    browserPresentation?: BrowserAuthenticationPresentation;
}

export interface CreatePublicOAuthClientOptions {
    clientId: string;
    redirectUrl: string;
    scopes: readonly string[];
    authorizationServer: OAuthAuthorizationServer;
    runtime: RuntimeAdapter;
    dangerouslyPersistSecrets?: boolean;
    resolveUserId(accessToken: string): string | Promise<string>;
    fetch?: typeof globalThis.fetch;
}

export interface PublicOAuthClient {
    signIn(options?: PublicOAuthSignInOptions): Promise<OAuthSession>;
    completeRedirect(url: string): Promise<OAuthSession | undefined>;
    restoreSessions(): Promise<readonly OAuthSession[]>;
    refresh(userId: string): Promise<OAuthSession>;
    getAccessToken(userId: string): Promise<string>;
    revoke(userId: string): Promise<void>;
    cleanup(): Promise<void>;
}
