import { BackendError } from "@party-stack/ontology-backend";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { Effect, Schema } from "effect";
import { connectOntology } from "./spec/index.js";
import type { Connection } from "./types.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { BrowserAuthentication, BrowserAuthenticationPresentation } from "@party-stack/runtime";

/** A credential owner's native backend plus its fixed authorization binding.
 * Transports project this policy before exposing the backend to a caller.
 */
export interface OAuthAuthorizationSource {
    readonly backend: OntologyBackendService;
    readonly ir: OntologyIR;
    readonly context: {
        readonly applicationId: string;
        readonly principalId: string;
        readonly redirectUrl: string;
    };
}

export interface OAuthAuthorizationClient {
    readonly redirectUrl: string;
    readonly signIn: (options?: {
        browserPresentation?: BrowserAuthenticationPresentation;
        connectionId?: string;
    }) => Effect.Effect<Connection<"active"> & { readonly id: string }, BackendError>;
    readonly complete: (
        callbackUrl: string
    ) => Effect.Effect<(Connection<"active"> & { readonly id: string }) | undefined, BackendError>;
}

/** Only connection identity/status is readable. Credentials and PKCE attempts stay private. */
export const oauthAuthorizationOntology: OntologyIR = {
    ...connectOntology,
    context: {
        type: o.struct({
            fields: [
                { name: "applicationId", displayName: "Connector", type: o.string({}) },
                { name: "principalId", displayName: "Principal", type: o.string({}) },
                { name: "redirectUrl", displayName: "Redirect URL", type: o.string({}) },
            ],
        }),
    },
    policy: {
        objects: {
            select: [
                q.sub("connections", {
                    from: { source: { objectType: "OAuthConnection" }, binding: "c" },
                    where: q.eq(q.field("c", "application"), q.context("applicationId")),
                    select: ["id", "userId", "status"].map((name) => q.selectField(name, q.field("c", name))),
                }),
            ],
        },
        actions: [
            {
                actionType: "beginAuthorization",
                check: q.literal(true),
                bind: ["applicationId", "principalId", "redirectUrl"].map((parameter) => ({
                    parameter,
                    expression: q.context(parameter),
                })),
                additionalObjects: {
                    select: [
                        q.sub("application", {
                            from: { source: { objectType: "OAuthApplication" }, binding: "application" },
                            where: q.eq(q.field("application", "id"), q.context("applicationId")),
                            select: [q.selectField("id", q.field("application", "id"))],
                        }),
                    ],
                },
            },
            {
                actionType: "completeAuthorization",
                check: q.literal(true),
                bind: [{ parameter: "principalId", expression: q.context("principalId") }],
            },
        ],
    },
};

/** Trusted in-process counterpart of the server's IR policy binding. */
export function bindOAuthAuthorizationBackend(source: OAuthAuthorizationSource): OntologyBackendService {
    return {
        ...source.backend,
        applyAction: (request) => {
            const parameters =
                request.name === "beginAuthorization"
                    ? { ...request.parameters, ...source.context }
                    : request.name === "completeAuthorization"
                      ? { ...request.parameters, principalId: source.context.principalId }
                      : undefined;
            return parameters
                ? source.backend.applyAction({ ...request, parameters })
                : Effect.fail(
                      new BackendError({
                          operation: "authorization",
                          kind: "NotImplemented",
                          retryable: false,
                          message: "Unknown authorization action.",
                      })
                  );
        },
    };
}

const Started = Schema.Struct({ id: Schema.String, authorizationUrl: Schema.String });
const Completed = Schema.Struct({ connectionId: Schema.String });
const Account = Schema.Struct({ userId: Schema.String, status: Schema.Literal("active") });
const invalid = () =>
    new BackendError({
        operation: "authorization",
        kind: "InvalidResponse",
        retryable: false,
        message: "Authorization returned an invalid response.",
    });

/** Browser orchestration over ordinary Connect actions; no dedicated OAuth RPCs. */
export function makeOAuthAuthorizationClient(options: {
    backend: OntologyBackendService;
    applicationId?: string;
    redirectUrl: string;
    browserAuthentication?: BrowserAuthentication;
}): OAuthAuthorizationClient {
    const apply = (name: string, parameters: Record<string, unknown>) =>
        options.backend.applyAction({ id: crypto.randomUUID(), name, parameters });
    const complete = Effect.fn("Connect.authorization.complete")(function* (callbackUrl: string) {
        const url = yield* Effect.try({ try: () => new URL(callbackUrl), catch: invalid });
        if (!url.searchParams.has("state")) return;
        const receipt = yield* apply("completeAuthorization", { callbackUrl });
        const { connectionId } = yield* Schema.decodeUnknownEffect(Completed)(receipt.result).pipe(
            Effect.mapError(invalid)
        );
        const rows = yield* options.backend.query({
            select: [
                q.sub("connection", {
                    from: { source: { objectType: "OAuthConnection" }, binding: "c" },
                    where: q.eq(q.field("c", "id"), q.literal(connectionId)),
                    page: { limit: 1 },
                    select: [
                        q.selectField("userId", q.field("c", "userId")),
                        q.selectField("status", q.field("c", "status")),
                    ],
                }),
            ],
        });
        const [account] = yield* Schema.decodeUnknownEffect(Schema.Array(Account))(rows.connection).pipe(
            Effect.mapError(invalid)
        );
        if (!account) return yield* invalid();
        return { id: connectionId, userId: account.userId, state: { status: "active" as const } };
    });
    return {
        redirectUrl: options.redirectUrl,
        complete,
        signIn: Effect.fn("Connect.authorization.signIn")(
            function* (settings) {
                const browser = options.browserAuthentication;
                if (!browser)
                    return yield* new BackendError({
                        operation: "authorization",
                        kind: "InvalidConfiguration",
                        retryable: false,
                        message: "Interactive authorization requires a browser authentication capability.",
                    });
                const presentation = yield* browser.start({
                    redirectUrl: options.redirectUrl,
                    presentation: settings?.browserPresentation,
                });
                const receipt = yield* apply("beginAuthorization", {
                    applicationId: options.applicationId,
                    redirectUrl: options.redirectUrl,
                    connectionId: settings?.connectionId,
                });
                const started = yield* Schema.decodeUnknownEffect(Started)(receipt.result).pipe(
                    Effect.mapError(invalid)
                );
                const { callbackUrl } = yield* presentation.open(started.authorizationUrl);
                const connection = yield* complete(callbackUrl);
                if (!connection) return yield* invalid();
                return connection;
            },
            Effect.scoped,
            Effect.mapError((cause) =>
                cause instanceof BackendError
                    ? cause
                    : new BackendError({
                          operation: "authorization.presentation",
                          kind: "Unavailable",
                          retryable: false,
                          message: cause.message,
                      })
            )
        ),
    };
}
