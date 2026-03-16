import { performLocalOAuthFlow } from "@bobbyfidz/local-oauth-flow";
import { invariant } from "@bobbyfidz/panic";
import type { OntologyConfig, OntologyConfigAdapter } from "@party-stack/ontology";
import { createFoundryMetaOntologyAdapter } from "../meta/createOntologyMetadataCollections.js";
import { createOntologyClient, type OntologyClient } from "../utils/client.js";

const DEFAULT_FOUNDRY_SCOPES = ["api:read-data", "offline_access"];

export interface FoundryOntologyConfigAdapterOpts {
    foundryUrl: string;
    foundryOntologyRid: string;
    foundryClientId: string;
    foundryRedirectUrl: string;
}

export async function createFoundryOntologyClient(
    config: FoundryOntologyConfigAdapterOpts
): Promise<OntologyClient> {
    const { accessToken } = await performLocalOAuthFlow({
        issuerUrl: `${config.foundryUrl}/multipass/api`,
        authorizationUrl: `${config.foundryUrl}/multipass/api/oauth2/authorize`,
        tokenUrl: `${config.foundryUrl}/multipass/api/oauth2/token`,
        clientId: config.foundryClientId,
        redirectUrl: config.foundryRedirectUrl,
        scopes: DEFAULT_FOUNDRY_SCOPES,
    });

    return createOntologyClient({
        baseUrl: config.foundryUrl,
        ontologyRid: config.foundryOntologyRid,
        tokenProvider: () => Promise.resolve(accessToken),
    });
}

function getDefaultEnvValue(key: string): string {
    const value =
        process.env[key] ??
        process.env[`NEXT_PUBLIC_${key}`] ??
        process.env[`VITE_PUBLIC_${key}`] ??
        process.env[`EXPO_PUBLIC_${key}`];
    invariant(value);
    return value;
}

export const foundryOntologyConfigAdapter: OntologyConfigAdapter<
    FoundryOntologyConfigAdapterOpts | undefined
> = {
    createAdapter: async (opts) => {
        const client = await createFoundryOntologyClient({
            foundryUrl: opts?.foundryUrl ?? getDefaultEnvValue("FOUNDRY_URL"),
            foundryOntologyRid: opts?.foundryOntologyRid ?? getDefaultEnvValue("FOUNDRY_ONTOLOGY_RID"),
            foundryClientId: opts?.foundryClientId ?? getDefaultEnvValue("FOUNDRY_CLIENT_ID"),
            foundryRedirectUrl: opts?.foundryRedirectUrl ?? getDefaultEnvValue("FOUNDRY_REDIRECT_URL"),
        });
        return createFoundryMetaOntologyAdapter({ client });
    },
};

export type FoundryOntologyConfig = OntologyConfig<FoundryOntologyConfigAdapterOpts>;
