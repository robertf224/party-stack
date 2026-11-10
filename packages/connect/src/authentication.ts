import { BackendError } from "@party-stack/ontology-backend";
import * as q from "@party-stack/ontology-spec/query";
import { Effect, Schema } from "effect";
import { makeOAuthAuthorizationClient } from "./authorization.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { BrowserAuthentication } from "@party-stack/runtime";

export type AccountRef = {
    readonly kind: "oauth" | "api-key" | "external-session";
    readonly id: string;
};

export interface AccountSummary extends AccountRef {
    readonly userId?: string;
    readonly title: string;
    readonly status: "active" | "needs-auth" | "inactive";
}
const invalid = () =>
    new BackendError({
        operation: "connect.client",
        kind: "InvalidResponse",
        retryable: false,
        message: "Connect returned an invalid response.",
    });
const ConnectionResult = Schema.Struct({ connectionId: Schema.NonEmptyString });

/** Effect-native commands and inventory queries over an ordinary Connect backend.
 * Authentication actions execute directly; callers own the backend's Scope.
 */
export function makeAuthenticationClient(options: {
    readonly backend: OntologyBackendService;
    readonly browserAuthentication?: BrowserAuthentication;
}) {
    const apply = (name: string, parameters: Record<string, unknown>) =>
        options.backend.applyAction({ id: crypto.randomUUID(), name, parameters });
    const create = (name: string, parameters: Record<string, unknown>) =>
        apply(name, parameters).pipe(
            Effect.flatMap((receipt) =>
                Schema.decodeUnknownEffect(ConnectionResult)(receipt.result).pipe(Effect.mapError(invalid))
            )
        );
    return {
        oauth: (settings: { readonly applicationId: string; readonly redirectUrl: string }) => {
            const oauth = makeOAuthAuthorizationClient({ ...options, ...settings });
            return {
                ...oauth,
                signIn: (input?: Parameters<typeof oauth.signIn>[0]) =>
                    oauth
                        .signIn(input)
                        .pipe(Effect.map((account) => ({ ...account, kind: "oauth" as const }))),
                complete: (url: string) =>
                    oauth
                        .complete(url)
                        .pipe(Effect.map((account) => account && { ...account, kind: "oauth" as const })),
            };
        },
        attachExternalSession: (serviceInstanceId: string, sessionId: string) =>
            create("attachExternalSession", { serviceInstanceId, sessionId }).pipe(
                Effect.map((result) => ({
                    kind: "external-session" as const,
                    id: result.connectionId,
                }))
            ),
        connectApiKey: (serviceInstanceId: string, apiKey: string) =>
            create("connectApiKey", { serviceInstanceId, apiKey }).pipe(
                Effect.map((result) => ({ kind: "api-key" as const, id: result.connectionId }))
            ),
        signOut: (account: AccountRef) =>
            apply(
                account.kind === "oauth"
                    ? "disconnectConnection"
                    : account.kind === "api-key"
                      ? "disconnectApiKey"
                      : "disconnectExternalSession",
                { connectionId: account.id }
            ).pipe(Effect.asVoid),
        /** Remove a saved account. Downloaded application data is managed separately. */
        forget: (account: AccountRef) =>
            apply(
                account.kind === "oauth"
                    ? "forgetConnection"
                    : account.kind === "api-key"
                      ? "forgetApiKey"
                      : "forgetExternalSession",
                { connectionId: account.id }
            ).pipe(Effect.asVoid),
        connections: Effect.gen(function* () {
            const types = ["OAuthConnection", "ApiKeyConnection", "ExternalSessionConnection"] as const;
            const result = yield* options.backend.query({
                select: types.map((objectType) =>
                    q.sub(objectType, {
                        from: { source: { objectType }, binding: "c" },
                        select: ["id", "title", "userId", "status"].map((name) =>
                            q.selectField(name, q.field("c", name))
                        ),
                    })
                ),
            });
            const groups = yield* Effect.forEach(types, (objectType) =>
                Schema.decodeUnknownEffect(
                    Schema.Array(
                        Schema.Struct({
                            id: Schema.String,
                            title: Schema.String,
                            userId: Schema.optional(Schema.String),
                            status: Schema.Literals(["active", "needs-auth", "inactive"]),
                        })
                    )
                )(result[objectType]).pipe(
                    Effect.mapError(invalid),
                    Effect.map((rows) =>
                        rows.map((row): AccountSummary => ({
                            ...row,
                            kind:
                                objectType === "OAuthConnection"
                                    ? "oauth"
                                    : objectType === "ApiKeyConnection"
                                      ? "api-key"
                                      : "external-session",
                        }))
                    )
                )
            );
            return groups.flat();
        }),
    };
}
export type AuthenticationClient = ReturnType<typeof makeAuthenticationClient>;
