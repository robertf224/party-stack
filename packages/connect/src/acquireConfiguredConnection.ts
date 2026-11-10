import { BackendError } from "@party-stack/ontology-backend";
import { eq, field } from "@party-stack/ontology-storage";
import { Effect } from "effect";
import { makeAuthenticationClient } from "./authentication.js";
import { connectBackendError } from "./core/backend.js";
import type { ConnectManagerService } from "./makeConnectManager.js";
import type { ConnectionRef } from "./ServiceConnector.js";
import type { BrowserAuthentication } from "@party-stack/runtime";

/** CLI/bootstrap selection: reuse a saved account or execute the explicitly
 * configured authentication flow. All credentials and I/O belong to manager.
 */
export const acquireConfiguredConnection = Effect.fn("Connect.acquireConfiguredConnection")(
    function* (options: {
        readonly manager: ConnectManagerService;
        readonly serviceInstanceId: string;
        readonly oauth?: { readonly applicationId: string; readonly redirectUrl: string };
        readonly apiKey?: string;
        readonly userId?: string;
        readonly browserAuthentication?: BrowserAuthentication;
    }) {
        const { manager } = options;
        const client = makeAuthenticationClient({
            backend: manager.backend,
            browserAuthentication: options.browserAuthentication,
        });
        const invalid = (message: string) =>
            new BackendError({
                operation: "connect.select",
                kind: "InvalidConfiguration",
                retryable: false,
                message,
            });
        let selected: ConnectionRef | undefined;
        if (options.apiKey) {
            const account = yield* client.connectApiKey(options.serviceInstanceId, options.apiKey);
            selected = { objectType: "ApiKeyConnection", id: account.id };
        } else {
            const type = options.oauth ? "OAuthConnection" : "ApiKeyConnection";
            const rows = yield* manager.store
                .load(type, {
                    where: options.oauth
                        ? eq(field("application"), options.oauth.applicationId)
                        : eq(field("serviceInstance"), options.serviceInstanceId),
                })
                .pipe(Effect.mapError(connectBackendError));
            const active = rows.filter((row) => row.status === "active");
            if (!options.userId && active.length > 1)
                return yield* invalid(
                    "Multiple accounts are signed in. Set connection.userId in the pull configuration."
                );
            const existing = options.userId ? active.find((row) => row.userId === options.userId) : active[0];
            if (existing) selected = { objectType: type, id: existing.id };
            else if (options.oauth) {
                const previous = options.userId
                    ? rows.find((row) => row.userId === options.userId)
                    : undefined;
                const signedIn = yield* client.oauth(options.oauth).signIn({ connectionId: previous?.id });
                selected = { objectType: "OAuthConnection", id: signedIn.id };
            }
        }
        if (!selected) return yield* invalid("Configure OAuth or an API token, or select a saved account.");
        const access = yield* manager.connections.acquire(selected);
        if (access.serviceInstance.id !== options.serviceInstanceId)
            return yield* invalid("The selected connection belongs to a different service instance.");
        if (options.userId && access.userId !== options.userId)
            return yield* invalid(
                `Authenticated as "${access.userId}", but connection.userId is "${options.userId}".`
            );
        return access;
    }
);
