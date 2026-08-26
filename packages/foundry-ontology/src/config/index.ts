import { performLocalOAuthFlow } from "@bobbyfidz/local-oauth-flow";
import { invariant } from "@bobbyfidz/panic";
import { createOntologyClient, type OntologyClient } from "@party-stack/foundry-client";
import {
    o,
    type Lens,
    type OntologyPullSource,
    type OntologyPullConfig,
    type OntologyIR,
} from "@party-stack/ontology";
import { createFoundryMetaOntologyBackendAdapter } from "../meta/createFoundryMetaOntologyBackendAdapter.js";
import { createFoundryUserObjectType } from "../users/foundryUser.js";
import {
    applyAttachmentConstraintOverrides,
    type FoundryAttachmentConstraintOverride,
} from "./applyAttachmentConstraintOverrides.js";

export type { FoundryAttachmentConstraintOverride } from "./applyAttachmentConstraintOverrides.js";

const DEFAULT_FOUNDRY_SCOPES = ["api:use-ontologies-read", "offline_access"];

export interface FoundryOntologyPullClientOptions {
    foundryUrl: string;
    foundryOntologyRid: string;
    foundryClientId: string;
    foundryRedirectUrl: string;
}

export interface FoundryOntologyPullOptions
    extends Partial<FoundryOntologyPullClientOptions> {
    foundryToken?: string;
    attachmentConstraints?: FoundryAttachmentConstraintOverride[];
    users?: {
        objectType: string;
        lens: Lens;
    };
}

export async function createFoundryOntologyPullClient(
    config: FoundryOntologyPullClientOptions
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

function getOptionalEnvValue(key: string): string | undefined {
    return (
        process.env[key] ??
        process.env[`NEXT_PUBLIC_${key}`] ??
        process.env[`VITE_PUBLIC_${key}`] ??
        process.env[`EXPO_PUBLIC_${key}`]
    );
}

function addConfiguredUser(
    ontology: OntologyIR,
    users: FoundryOntologyPullOptions["users"]
): OntologyIR {
    if (!users) return ontology;
    const userObjectType = createFoundryUserObjectType(users.objectType, users.lens);
    return {
        ...ontology,
        objectTypes: [
            ...ontology.objectTypes.filter((objectType) => objectType.name !== users.objectType),
            userObjectType,
        ],
        contextType: o.struct({
            fields: [
                {
                    name: "user",
                    displayName: "User",
                    type: o.objectReference({ objectType: users.objectType }),
                },
            ],
        }),
    };
}

export const foundryOntologyPullSource: OntologyPullSource<
    FoundryOntologyPullOptions | undefined
> = {
    createBackend: async (opts) => {
        const foundryUrl = opts?.foundryUrl ?? getDefaultEnvValue("FOUNDRY_URL");
        const foundryOntologyRid =
            opts?.foundryOntologyRid ?? getDefaultEnvValue("FOUNDRY_ONTOLOGY_RID");
        const token = opts?.foundryToken ?? getOptionalEnvValue("FOUNDRY_TOKEN");
        const client = token
            ? createOntologyClient({
                  baseUrl: foundryUrl,
                  ontologyRid: foundryOntologyRid,
                  tokenProvider: () => Promise.resolve(token),
              })
            : await createFoundryOntologyPullClient({
                  foundryUrl,
                  foundryOntologyRid,
                  foundryClientId:
                      opts?.foundryClientId ?? getDefaultEnvValue("FOUNDRY_CLIENT_ID"),
                  foundryRedirectUrl:
                      opts?.foundryRedirectUrl ?? getDefaultEnvValue("FOUNDRY_REDIRECT_URL"),
              });
        return createFoundryMetaOntologyBackendAdapter({
            client,
        });
    },
    transformPulledOntology: (ontology, opts) =>
        addConfiguredUser(
            applyAttachmentConstraintOverrides(
                ontology,
                opts?.attachmentConstraints ?? []
            ),
            opts?.users
        ),
};

export type FoundryOntologyPullConfig =
    OntologyPullConfig<FoundryOntologyPullOptions>;
