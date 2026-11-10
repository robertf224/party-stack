import { makeAuthenticationClient } from "@party-stack/connect";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { ontologyCollections } from "./tanstack/descriptors.js";
import type { AccountRef } from "@party-stack/connect";
import type { ConnectOntology } from "@party-stack/connect/spec";
import type { BackendError } from "@party-stack/ontology-backend";
import type { OntologyClient, OntologyServerClient } from "@party-stack/ontology-server/rpc";
import type { RuntimesLayer } from "@party-stack/runtime";

/** Collection descriptors for live queries over Connect's saved accounts and
 * configuration. Resolve them through the authentication view's DbClient.
 * Importing descriptors does not open a client or grant access to secret fields.
 */
export const { objects: authenticationObjects } = ontologyCollections<ConnectOntology>({
    ServiceInstance: "id",
    OAuthApplication: "id",
    OAuthConnection: "id",
    ApiKeyConnection: "id",
    ExternalSessionConnection: "id",
    OAuthAuthorizationAttempt: "id",
});
export type { AccountRef, AccountSummary } from "@party-stack/connect";

export interface AuthenticationClientOptions {
    readonly client:
        | OntologyServerClient
        | Effect.Effect<OntologyClient | OntologyServerClient, BackendError, Scope.Scope>;
    readonly ontology?: string;
    readonly runtime?: RuntimesLayer;
}

/** Promise browser commands over the selected Connect ontology. Inventory is read
 * from its ordinary Query endpoint; no account stream or authentication-method proxy.
 * Authentication workflows execute directly and never enter an optimistic outbox.
 */
export async function createAuthenticationClient(options: AuthenticationClientOptions) {
    const scope = Effect.runSync(Scope.make());
    return Effect.runPromise(
        Scope.provide(
            Effect.gen(function* () {
                const environment = yield* Layer.build(
                    options.runtime ?? Runtimes.layer(MemoryRuntime.layer)
                );
                const browserAuthentication = (yield* Runtimes.pipe(Effect.provideContext(environment)))
                    .browserAuthentication;
                const remote = yield* Effect.isEffect(options.client)
                    ? options.client
                    : Effect.succeed(options.client);
                const client =
                    "ontology" in remote ? yield* remote.ontology(options.ontology ?? "connect") : remote;
                const run = <A, E>(work: Effect.Effect<A, E>) =>
                    Effect.runPromise(
                        Effect.acquireUseRelease(
                            Effect.forkIn(work, scope, { startImmediately: true }),
                            Fiber.join,
                            Fiber.interrupt
                        )
                    );
                const commands = makeAuthenticationClient({ backend: client.backend, browserAuthentication });
                return {
                    oauth(settings: Parameters<typeof commands.oauth>[0]) {
                        const oauth = commands.oauth(settings);
                        return {
                            signIn: (settings?: Parameters<typeof oauth.signIn>[0]) =>
                                run(oauth.signIn(settings)),
                            complete: (url: string) => run(oauth.complete(url)),
                        };
                    },
                    attachExternalSession: (instance: string, session: string) =>
                        run(commands.attachExternalSession(instance, session)),
                    connectApiKey: (instance: string, key: string) =>
                        run(commands.connectApiKey(instance, key)),
                    signOut: (account: AccountRef) => run(commands.signOut(account)),
                    forget: (account: AccountRef) => run(commands.forget(account)),
                    connections: () => run(commands.connections),
                    cleanup: () => Effect.runPromise(Scope.close(scope, Exit.void)),
                };
            }),
            scope
        ).pipe(
            Effect.mapError((error) => classifyBackendFailure("connect.client", error)),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void))
        )
    );
}

export type AuthenticationClient = Awaited<ReturnType<typeof createAuthenticationClient>>;
