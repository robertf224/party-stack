export interface FoundryOAuthConnectionOptions {
    clientId: string;
    redirectUrl: string;
    scopes?: string[];
    fetch?: typeof globalThis.fetch;
}
