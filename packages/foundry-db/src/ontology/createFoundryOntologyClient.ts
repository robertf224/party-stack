import { performLocalOAuthFlow } from "@bobbyfidz/local-oauth-flow";
import { createOntologyClient, type OntologyClient } from "../utils/client.js";

const DEFAULT_FOUNDRY_SCOPES = ["api:read-data", "offline_access"] as const;

export interface FoundryOntologyAuthConfig {
    foundryUrl: string;
    foundryOntologyRid: string;
    foundryClientId: string;
    foundryRedirectUrl: string;
    foundryScopes?: string[];
}

export async function createFoundryOntologyClient(
    config: FoundryOntologyAuthConfig
): Promise<OntologyClient> {
    const { accessToken } = await performLocalOAuthFlow({
        issuerUrl: `${config.foundryUrl}/multipass/api`,
        authorizationUrl: `${config.foundryUrl}/multipass/api/oauth2/authorize`,
        tokenUrl: `${config.foundryUrl}/multipass/api/oauth2/token`,
        clientId: config.foundryClientId,
        redirectUrl: config.foundryRedirectUrl,
        scopes: config.foundryScopes ?? [...DEFAULT_FOUNDRY_SCOPES],
    });

    return createOntologyClient({
        baseUrl: config.foundryUrl,
        ontologyRid: config.foundryOntologyRid,
        tokenProvider: () => Promise.resolve(accessToken),
    });
}

export function getDefaultEnvValue(key: string): string | undefined {
    return (
        process.env[key] ??
        process.env[`NEXT_PUBLIC_${key}`] ??
        process.env[`VITE_PUBLIC_${key}`] ??
        process.env[`EXPO_PUBLIC_${key}`]
    );
}
