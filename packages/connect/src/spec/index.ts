import { defineOntology, o, type Infer } from "@party-stack/ontology-spec";

const text = o.string({});
const secret = o.optional({ type: o.encrypted({ type: text }) });
const optionalText = o.optional({ type: text });
const optionalTime = o.optional({ type: o.timestamp({}) });
const reference = <const Name extends string>(objectType: Name) => o.objectReference({ objectType });
const enumeration = <const Value extends string>(...values: Value[]) =>
    o.string({
        constraint: o.StringConstraint.enum({ options: values.map((value) => ({ value, label: value })) }),
    });

/** Portable definitions. Applications may add properties/links before compiling them.
 * Connection and attempt instances are private to the credential authority.
 */
export const connectOntology = defineOntology({
    types: [],
    objectTypes: [
        {
            name: "Installation",
            pluralDisplayName: "Installations",
            displayName: "Installation",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: text },
                { name: "title", displayName: "Title", type: text },
                { name: "providerId", displayName: "Provider id", type: text },
                { name: "instanceUrl", displayName: "Instance url", type: text },
            ],
        },
        {
            name: "OAuthConnector",
            pluralDisplayName: "OAuthConnectors",
            displayName: "OAuth connector",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: text },
                { name: "title", displayName: "Title", type: text },
                { name: "installation", displayName: "Installation", type: reference("Installation") },
                {
                    name: "flow",
                    displayName: "Flow",
                    type: enumeration("authorization-code", "client-credentials"),
                },
                { name: "clientId", displayName: "Client id", type: text },
                { name: "clientSecret", displayName: "Client secret", type: secret },
                { name: "providerAppId", displayName: "Provider app id", type: optionalText },
                {
                    name: "connection",
                    displayName: "Connection",
                    type: o.optional({ type: reference("OAuthConnection") }),
                },
            ],
        },
        {
            name: "OAuthConnection",
            pluralDisplayName: "OAuthConnections",
            displayName: "OAuth connection",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: text },
                { name: "title", displayName: "Title", type: text },
                { name: "connector", displayName: "Connector", type: reference("OAuthConnector") },
                { name: "providerSubjectId", displayName: "Provider subject id", type: optionalText },
                {
                    name: "status",
                    displayName: "Status",
                    type: enumeration("active", "needs-auth", "inactive"),
                },
                { name: "accessToken", displayName: "Access token", type: secret },
                { name: "accessTokenExpiresAt", displayName: "Access token expires at", type: optionalTime },
                { name: "refreshToken", displayName: "Refresh token", type: secret },
                {
                    name: "refreshTokenExpiresAt",
                    displayName: "Refresh token expires at",
                    type: optionalTime,
                },
                { name: "grantedScopes", displayName: "Granted scopes", type: optionalText },
                { name: "operationId", displayName: "Operation id", type: optionalText },
                { name: "operationExpiresAt", displayName: "Operation expires at", type: optionalTime },
            ],
        },
        {
            name: "OAuthAuthorizationAttempt",
            pluralDisplayName: "OAuthAuthorizationAttempts",
            displayName: "OAuth authorization attempt",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: text },
                { name: "connector", displayName: "Connector", type: reference("OAuthConnector") },
                { name: "principalId", displayName: "Principal id", type: text },
                { name: "connectionId", displayName: "Connection id", type: text },
                { name: "redirectUrl", displayName: "Redirect url", type: text },
                { name: "returnUrl", displayName: "Return url", type: optionalText },
                { name: "codeVerifier", displayName: "Code verifier", type: o.encrypted({ type: text }) },
                { name: "expiresAt", displayName: "Expires at", type: o.timestamp({}) },
                {
                    name: "status",
                    displayName: "Status",
                    type: enumeration("pending", "exchanging", "completed", "failed"),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
});
export type ConnectOntology = Infer<typeof connectOntology>;
export type InstallationRecord = ConnectOntology["objectTypes"]["Installation"];
export type OAuthConnectorRecord = ConnectOntology["objectTypes"]["OAuthConnector"];
export type OAuthConnectionRecord = ConnectOntology["objectTypes"]["OAuthConnection"];
export type OAuthAuthorizationAttemptRecord = ConnectOntology["objectTypes"]["OAuthAuthorizationAttempt"];

const definition = <const Name extends (typeof connectOntology.objectTypes)[number]["name"]>(name: Name) =>
    connectOntology.objectTypes.find((object) => object.name === name)! as Extract<
        (typeof connectOntology.objectTypes)[number],
        { name: Name }
    >;
export const installationDefinition = definition("Installation");
export const oauthConnectorDefinition = definition("OAuthConnector");
export const oauthConnectionDefinition = definition("OAuthConnection");
export const oauthAuthorizationAttemptDefinition = definition("OAuthAuthorizationAttempt");
