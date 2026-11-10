import type { ConnectError } from "./core/errors.js";
import type { ConnectCredentialValues, ConnectOAuthService } from "./core/oauthAuthority.js";
import type {
    ApiKeyConnectionRecord,
    ExternalSessionConnectionRecord,
    OAuthApplicationRecord,
    OAuthConnectionRecord,
    ServiceInstanceRecord,
} from "./spec/index.js";
import type { ConnectionEgressHandlers } from "./types.js";
import type { BackendError } from "@party-stack/ontology-backend";
import type { Effect, Scope } from "effect";
import type { Temporal } from "temporal-polyfill";

/** Concrete rows keep secrets in top-level encrypted properties. No runtime
 * polymorphism is required in the ontology or in a service's storage adapter.
 */
export type SavedConnection =
    | { readonly objectType: "OAuthConnection"; readonly value: OAuthConnectionRecord }
    | { readonly objectType: "ApiKeyConnection"; readonly value: ApiKeyConnectionRecord }
    | { readonly objectType: "ExternalSessionConnection"; readonly value: ExternalSessionConnectionRecord };
export type ConnectionRef = { readonly objectType: SavedConnection["objectType"]; readonly id: string };

export interface VerifiedServiceIdentity {
    readonly userId: string;
    readonly title?: string;
    readonly expiresAt?: Temporal.Instant;
}

/** Executable integration for a ServiceInstance. This is registered beside the
 * credential owner. UI sign-in helpers operate over Connect's ordinary actions.
 */
export interface ServiceConnector {
    readonly service: string;
    readonly displayName?: string;
    readonly defaultOAuthScopes?: readonly string[];
    readonly oauth?: (input: {
        readonly application: OAuthApplicationRecord;
        readonly serviceInstance: ServiceInstanceRecord;
        readonly values: ConnectCredentialValues;
    }) => Effect.Effect<ConnectOAuthService, ConnectError>;
    readonly apiKey?: (input: {
        readonly serviceInstance: ServiceInstanceRecord;
        readonly apiKey: string;
    }) => Effect.Effect<VerifiedServiceIdentity, ConnectError>;
    readonly externalSession?: (input: {
        readonly serviceInstance: ServiceInstanceRecord;
        readonly sessionId: string;
    }) => Effect.Effect<VerifiedServiceIdentity, ConnectError>;
    readonly disconnectExternalSession?: (input: {
        readonly serviceInstance: ServiceInstanceRecord;
        readonly sessionId: string;
    }) => Effect.Effect<void, ConnectError>;
    readonly acquire: (input: {
        readonly connection: SavedConnection;
        readonly serviceInstance: ServiceInstanceRecord;
        /** Rechecks and decrypts the saved credential; OAuth refresh is coordinated by Connect. */
        readonly credential: Effect.Effect<string, BackendError>;
        /** Refresh a rejected OAuth credential only if it is still current. An
         * older response must not replace a newer login or another refresh.
         */
        readonly refreshCredential: (rejected: string) => Effect.Effect<string, BackendError>;
        readonly handlers: ConnectionEgressHandlers;
    }) => Effect.Effect<ConnectionEgressHandlers, BackendError, Scope.Scope>;
}
