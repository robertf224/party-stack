import { defineOntology, o, type Infer } from "@party-stack/ontology-spec";

/** Portable definitions. Applications may add properties/links before compiling them.
 * Connection and attempt instances are private to the credential authority.
 */
export const connectOntology = defineOntology({
    types: [],
    objectTypes: [
        {
            name: "ServiceInstance",
            pluralDisplayName: "Service instances",
            displayName: "Service instance",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                { name: "service", displayName: "Service", type: o.string({}) },
                { name: "instanceUrl", displayName: "Instance url", type: o.string({}) },
            ],
        },
        {
            name: "OAuthApplication",
            pluralDisplayName: "OAuthApplications",
            displayName: "OAuth application",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                {
                    name: "serviceInstance",
                    displayName: "Service instance",
                    type: o.objectReference({ objectType: "ServiceInstance" }),
                },
                {
                    name: "flow",
                    displayName: "Flow",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "authorization-code", label: "authorization-code" },
                                { value: "client-credentials", label: "client-credentials" },
                            ],
                        }),
                    }),
                },
                { name: "clientId", displayName: "Client id", type: o.string({}) },
                {
                    name: "scopes",
                    displayName: "Requested scopes",
                    type: o.optional({ type: o.list({ elementType: o.string({}) }) }),
                },
                {
                    name: "redirectUrl",
                    displayName: "Redirect URL",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "clientSecret",
                    displayName: "Client secret",
                    type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                },
                {
                    name: "serviceAppId",
                    displayName: "Service app id",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "connection",
                    displayName: "Connection",
                    type: o.optional({ type: o.objectReference({ objectType: "OAuthConnection" }) }),
                },
            ],
        },
        {
            name: "OAuthConnection",
            pluralDisplayName: "OAuthConnections",
            displayName: "OAuth connection",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                {
                    name: "application",
                    displayName: "Application",
                    type: o.objectReference({ objectType: "OAuthApplication" }),
                },
                {
                    name: "userId",
                    displayName: "User id",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "active", label: "active" },
                                { value: "needs-auth", label: "needs-auth" },
                                { value: "inactive", label: "inactive" },
                            ],
                        }),
                    }),
                },
                {
                    name: "accessToken",
                    displayName: "Access token",
                    type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                },
                {
                    name: "accessTokenExpiresAt",
                    displayName: "Access token expires at",
                    type: o.optional({ type: o.timestamp({}) }),
                },
                {
                    name: "refreshToken",
                    displayName: "Refresh token",
                    type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                },
                {
                    name: "refreshTokenExpiresAt",
                    displayName: "Refresh token expires at",
                    type: o.optional({ type: o.timestamp({}) }),
                },
                {
                    name: "grantedScopes",
                    displayName: "Granted scopes",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "operationId",
                    displayName: "Operation id",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "operationExpiresAt",
                    displayName: "Operation expires at",
                    type: o.optional({ type: o.timestamp({}) }),
                },
            ],
        },
        {
            name: "ApiKeyConnection",
            pluralDisplayName: "API key connections",
            displayName: "API key connection",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                {
                    name: "serviceInstance",
                    displayName: "Service instance",
                    type: o.objectReference({ objectType: "ServiceInstance" }),
                },
                { name: "userId", displayName: "User id", type: o.string({}) },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "active", label: "Active" },
                                { value: "needs-auth", label: "Needs authentication" },
                                { value: "inactive", label: "Inactive" },
                            ],
                        }),
                    }),
                },
                {
                    name: "apiKey",
                    displayName: "API key",
                    type: o.optional({ type: o.encrypted({ type: o.string({}) }) }),
                },
                { name: "expiresAt", displayName: "Expires at", type: o.optional({ type: o.timestamp({}) }) },
            ],
        },
        {
            name: "ExternalSessionConnection",
            pluralDisplayName: "External session connections",
            displayName: "External session connection",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
                {
                    name: "serviceInstance",
                    displayName: "Service instance",
                    type: o.objectReference({ objectType: "ServiceInstance" }),
                },
                { name: "userId", displayName: "User id", type: o.string({}) },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "active", label: "Active" },
                                { value: "needs-auth", label: "Needs authentication" },
                                { value: "inactive", label: "Inactive" },
                            ],
                        }),
                    }),
                },
                // A selector, not a transferable credential. The service must verify its own session.
                { name: "sessionId", displayName: "Session id", type: o.string({}) },
                { name: "expiresAt", displayName: "Expires at", type: o.optional({ type: o.timestamp({}) }) },
            ],
        },
        {
            name: "OAuthAuthorizationAttempt",
            pluralDisplayName: "OAuthAuthorizationAttempts",
            displayName: "OAuth authorization attempt",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "Id", type: o.string({}) },
                {
                    name: "application",
                    displayName: "Application",
                    type: o.objectReference({ objectType: "OAuthApplication" }),
                },
                {
                    name: "principalId",
                    displayName: "Principal id",
                    type: o.optional({ type: o.string({}) }),
                },
                {
                    name: "connectionId",
                    displayName: "Connection id",
                    type: o.string({}),
                },
                { name: "redirectUrl", displayName: "Redirect url", type: o.string({}) },
                { name: "returnUrl", displayName: "Return url", type: o.optional({ type: o.string({}) }) },
                {
                    name: "codeVerifier",
                    displayName: "Code verifier",
                    type: o.encrypted({ type: o.string({}) }),
                },
                { name: "expiresAt", displayName: "Expires at", type: o.timestamp({}) },
                {
                    name: "status",
                    displayName: "Status",
                    type: o.string({
                        constraint: o.StringConstraint.enum({
                            options: [
                                { value: "pending", label: "pending" },
                                { value: "exchanging", label: "exchanging" },
                                { value: "completed", label: "completed" },
                                { value: "failed", label: "failed" },
                            ],
                        }),
                    }),
                },
            ],
        },
    ],
    linkTypes: [],
    actionTypes: [
        {
            name: "beginAuthorization",
            displayName: "Begin authorization",
            logic: [],
            parameters: [
                {
                    name: "applicationId",
                    displayName: "Application",
                    type: o.objectReference({ objectType: "OAuthApplication" }),
                },
                { name: "principalId", displayName: "Principal", type: o.optional({ type: o.string({}) }) },
                { name: "redirectUrl", displayName: "Redirect URL", type: o.string({}) },
                { name: "returnUrl", displayName: "Return URL", type: o.optional({ type: o.string({}) }) },
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.optional({ type: o.objectReference({ objectType: "OAuthConnection" }) }),
                },
            ],
            returnType: o.struct({
                fields: [
                    { name: "id", displayName: "Attempt", type: o.string({}) },
                    { name: "authorizationUrl", displayName: "Authorization URL", type: o.string({}) },
                ],
            }),
        },
        {
            name: "completeAuthorization",
            displayName: "Complete authorization",
            logic: [],
            parameters: [
                { name: "callbackUrl", displayName: "Callback URL", type: o.string({}) },
                { name: "principalId", displayName: "Principal", type: o.optional({ type: o.string({}) }) },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "connectionId",
                        displayName: "Connection",
                        type: o.objectReference({ objectType: "OAuthConnection" }),
                    },
                ],
            }),
        },
        {
            name: "connectClientCredentials",
            displayName: "Connect client credentials",
            logic: [],
            parameters: [
                {
                    name: "applicationId",
                    displayName: "Application",
                    type: o.objectReference({ objectType: "OAuthApplication" }),
                },
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.optional({ type: o.objectReference({ objectType: "OAuthConnection" }) }),
                },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "connectionId",
                        displayName: "Connection",
                        type: o.objectReference({ objectType: "OAuthConnection" }),
                    },
                ],
            }),
        },
        {
            name: "refreshConnection",
            displayName: "Refresh connection",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "OAuthConnection" }),
                },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "connectionId",
                        displayName: "Connection",
                        type: o.objectReference({ objectType: "OAuthConnection" }),
                    },
                ],
            }),
        },
        {
            name: "disconnectConnection",
            displayName: "Disconnect connection",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "OAuthConnection" }),
                },
            ],
        },
        {
            name: "forgetConnection",
            displayName: "Forget connection",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "OAuthConnection" }),
                },
            ],
        },
        {
            name: "connectApiKey",
            displayName: "Connect API key",
            logic: [],
            parameters: [
                {
                    name: "serviceInstanceId",
                    displayName: "Service instance",
                    type: o.objectReference({ objectType: "ServiceInstance" }),
                },
                { name: "apiKey", displayName: "API key", type: o.string({}) },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "connectionId",
                        displayName: "Connection",
                        type: o.objectReference({ objectType: "ApiKeyConnection" }),
                    },
                ],
            }),
        },
        {
            name: "attachExternalSession",
            displayName: "Attach external session",
            logic: [],
            parameters: [
                {
                    name: "serviceInstanceId",
                    displayName: "Service instance",
                    type: o.objectReference({ objectType: "ServiceInstance" }),
                },
                { name: "sessionId", displayName: "Session id", type: o.string({}) },
            ],
            returnType: o.struct({
                fields: [
                    {
                        name: "connectionId",
                        displayName: "Connection",
                        type: o.objectReference({ objectType: "ExternalSessionConnection" }),
                    },
                ],
            }),
        },
        {
            name: "disconnectApiKey",
            displayName: "Disconnect API key",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "ApiKeyConnection" }),
                },
            ],
        },
        {
            name: "forgetApiKey",
            displayName: "Forget API key",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "ApiKeyConnection" }),
                },
            ],
        },
        {
            name: "disconnectExternalSession",
            displayName: "Disconnect external session",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "ExternalSessionConnection" }),
                },
            ],
        },
        {
            name: "forgetExternalSession",
            displayName: "Forget external session",
            logic: [],
            parameters: [
                {
                    name: "connectionId",
                    displayName: "Connection",
                    type: o.objectReference({ objectType: "ExternalSessionConnection" }),
                },
            ],
        },
    ],
    queryFunctionTypes: [],
});
export type ConnectOntology = Infer<typeof connectOntology>;
export type ServiceInstanceRecord = ConnectOntology["objectTypes"]["ServiceInstance"];
export type OAuthApplicationRecord = ConnectOntology["objectTypes"]["OAuthApplication"];
export type OAuthConnectionRecord = ConnectOntology["objectTypes"]["OAuthConnection"];
export type ApiKeyConnectionRecord = ConnectOntology["objectTypes"]["ApiKeyConnection"];
export type ExternalSessionConnectionRecord = ConnectOntology["objectTypes"]["ExternalSessionConnection"];
export type OAuthAuthorizationAttemptRecord = ConnectOntology["objectTypes"]["OAuthAuthorizationAttempt"];
