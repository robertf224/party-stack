export interface SalesforceOAuthConnectionOptions {
    clientId: string;
    redirectUrl: string;
    loginUrl?: string;
    scopes?: string[];
    fetch?: typeof globalThis.fetch;
}
