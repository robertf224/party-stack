import {
    o,
    type Lens,
    type OntologyPullSource,
    type OntologyPullConfig,
    type OntologyIR,
} from "@party-stack/ontology";
import { type FoundryAuthenticationClient, type FoundryOAuthConnectionOptions } from "../connection.js";
import {
    createFoundryBackendInstallation,
    createFoundryOntologyRoute,
} from "../installation/createFoundryBackendInstallation.js";
import { createFoundryUserObjectType } from "../users/foundryUser.js";
import {
    applyAttachmentConstraintOverrides,
    type FoundryAttachmentConstraintOverride,
} from "./applyAttachmentConstraintOverrides.js";
import type { Connection } from "@party-stack/connections";

export type { FoundryAttachmentConstraintOverride } from "./applyAttachmentConstraintOverrides.js";

const DEFAULT_FOUNDRY_SCOPES = [
    "api:use-ontologies-read",
    "offline_access",
    "ontology:view-unredacted-action-type",
    "ontology:view-object-type",
];

export interface FoundryOntologyPullConnectionOptions {
    oauth?: FoundryOAuthConnectionOptions;
    token?: string;
    userId?: string;
}

export interface CreateFoundryOntologyPullSourceOptions {
    baseUrl: string;
    ontologyRid: string;
    connection: FoundryOntologyPullConnectionOptions;
    attachmentConstraints?: FoundryAttachmentConstraintOverride[];
    users?: { objectType: string; lens: Lens };
}

function addConfiguredUser(
    ontology: OntologyIR,
    users: CreateFoundryOntologyPullSourceOptions["users"]
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

export function createFoundryOntologyPullSource(
    options: CreateFoundryOntologyPullSourceOptions
): OntologyPullSource<FoundryAuthenticationClient> {
    return {
        ontologyId: options.ontologyRid,
        createInstallation: ({ runtime }) => {
            const scopes = options.connection.oauth?.scopes ?? DEFAULT_FOUNDRY_SCOPES;
            return createFoundryBackendInstallation({
                installationId: `foundry-pull:${options.baseUrl}:${options.ontologyRid}:${[...scopes].sort().join(",")}`,
                baseUrl: options.baseUrl,
                runtime,
                connections: {
                    token: options.connection.token,
                    oauth: options.connection.oauth ? { ...options.connection.oauth, scopes } : undefined,
                },
                routes: [createFoundryOntologyRoute({ ontologyId: options.ontologyRid })],
            });
        },
        async resolveConnection(installation) {
            const configuredUserId = options.connection.userId;
            const activeConnections = [...installation.connections.values()]
                .filter((connection) => connection.state.status === "active")
                .map((connection): Connection<"active"> => ({
                    userId: connection.userId,
                    state: connection.state as Connection<"active">["state"],
                }));

            if (!options.connection.token && !configuredUserId && activeConnections.length > 1) {
                throw new Error(
                    "Multiple Foundry users are signed in for this project. Set connection.userId in the ontology pull source."
                );
            }
            let connection = options.connection.token
                ? await installation.authentication.signIn.apiToken()
                : configuredUserId
                  ? activeConnections.find((candidate) => candidate.userId === configuredUserId)
                  : activeConnections[0];
            if (!connection && options.connection.oauth) {
                connection = await installation.authentication.signIn.oauth();
            }
            if (!connection) {
                throw new Error("Foundry ontology pull requires connection.oauth or connection.token.");
            }
            if (configuredUserId && connection.userId !== configuredUserId) {
                throw new Error(
                    `Foundry signed in as "${connection.userId}", but connection.userId is "${configuredUserId}".`
                );
            }
            return connection;
        },
        transformPulledOntology: (ontology) =>
            addConfiguredUser(
                applyAttachmentConstraintOverrides(ontology, options.attachmentConstraints ?? []),
                options.users
            ),
    };
}

export type FoundryOntologyPullConfig = OntologyPullConfig<FoundryAuthenticationClient>;
