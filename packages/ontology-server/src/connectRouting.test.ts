import { makeConnectManager, connectPublicOntologyIR, ConnectError } from "@party-stack/connect";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryBlobBytesStore, Runtime } from "@party-stack/runtime";
import { makeTestRuntime } from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, test } from "vite-plus/test";
import { makeOntologyServer } from "./routing.js";
import { makeOntologyHttpClient, makeOntologyHttpHandler } from "./rpcHttp.js";
import type { ServiceConnector } from "@party-stack/connect";

const issuesIR = {
    context: { type: o.struct({ fields: [{ name: "user", displayName: "User", type: o.string({}) }] }) },
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Issue",
            primaryKey: "id",
            displayName: "Issue",
            pluralDisplayName: "Issues",
            properties: [{ name: "id", displayName: "Id", type: o.string({}) }],
        },
    ],
};

test("one ontology server uses ordinary Connect actions to acquire OAuth and external-session backends without sending credentials to clients", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const key = yield* Effect.promise(() =>
                    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
                );
                const sent: string[] = [];
                const services: ServiceConnector[] = [
                    {
                        service: "test",
                        oauth: () =>
                            Effect.succeed({
                                authorizationUrl: ({ state }) =>
                                    Effect.succeed(`https://service.example/authorize?state=${state}`),
                                exchange: () =>
                                    Effect.succeed({ accessToken: "private-oauth-token", userId: "alice" }),
                                refresh: () => Effect.die("unused"),
                                clientCredentials: Effect.die("unused"),
                            }),
                        externalSession: ({ sessionId }) =>
                            sessionId === "valid-session"
                                ? Effect.succeed({ userId: "bob" })
                                : Effect.fail(
                                      new ConnectError({
                                          kind: "NeedsAuthentication",
                                          retryable: false,
                                          message: "Invalid session",
                                      })
                                  ),
                        acquire: ({ credential, handlers }) =>
                            Effect.succeed({
                                fetch: Effect.fnUntraced(function* (request: Request) {
                                    const headers = new Headers(request.headers);
                                    headers.set("X-Test-Credential", yield* credential);
                                    sent.push(headers.get("X-Test-Credential")!);
                                    return new Response();
                                }),
                                createWebSocket: (url, protocols) => handlers.createWebSocket(url, protocols),
                            }),
                    },
                ];
                const runtime = yield* makeTestRuntime({
                    owner: "connect",
                    namespace: "routing",
                    blobBytes: new MemoryBlobBytesStore(),
                    encryptionKeyring: Effect.succeed({
                        active: Effect.succeed({ id: "key", key }),
                        get: () => Effect.succeed(key),
                    }),
                });
                const authority = yield* makeConnectManager({
                    services: [
                        {
                            connector: services[0]!,
                            instances: [
                                {
                                    id: "test",
                                    title: "Test",
                                    instanceUrl: "https://service.example",
                                    OAuthApplications: [
                                        {
                                            id: "app",
                                            title: "App",
                                            clientId: "client",
                                            flow: "authorization-code",
                                            redirectUrl: "https://app.example/callback",
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                    startMaintenance: false,
                }).pipe(Effect.provideService(Runtime, runtime));
                const data = yield* makeOwnedBackend({
                    tables: yield* Memory.make(),
                    namespace: "issues",
                    ir: issuesIR,
                    mutators: {},
                });
                yield* data.storage.transaction((tx) => tx.put("Issue", { id: "issue-1" }));
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    resolve: Effect.fnUntraced(function* (name) {
                        if (name === "connect")
                            return {
                                kind: "proxy" as const,
                                backend: authority.backend,
                                ir: connectPublicOntologyIR,
                                context: {},
                            };
                        const [kind, id] = name.split("/");
                        if ((kind !== "OAuthConnection" && kind !== "ExternalSessionConnection") || !id)
                            return yield* new BackendError({
                                operation: "resolve",
                                kind: "NotFound",
                                retryable: false,
                                message: "Unknown ontology",
                            });
                        const session = yield* authority.connections.acquire({ objectType: kind, id });
                        yield* session.egress.fetch("https://service.example/check");
                        return {
                            kind: "owned" as const,
                            backend: data,
                            ir: issuesIR,
                            context: { user: session.userId },
                            dangerouslyAllowInternalAccess: true as const,
                        };
                    }),
                }).pipe(
                    Effect.flatMap((router) => makeOntologyHttpHandler(router)),
                    Effect.map((handleRequest) => ({ handleRequest }))
                );
                const open = (ontology: string) =>
                    makeOntologyHttpClient({ url: "https://app.example/rpc", ontology })
                        .pipe(Effect.flatMap((server) => server.ontology()))
                        .pipe(
                            Effect.provide(FetchHttpClient.layer),
                            Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                                server.handleRequest(new Request(input, init))
                            )
                        );
                const connect = yield* open("connect");
                expect(
                    connect
                        .ir!.objectTypes.find((type) => type.name === "OAuthConnection")!
                        .properties.map((property) => property.name)
                ).not.toContain("accessToken");
                const begin = yield* connect.backend.applyAction({
                    id: "begin",
                    name: "beginAuthorization",
                    parameters: { applicationId: "app", redirectUrl: "https://app.example/callback" },
                });
                const attempt = (begin.result as { id: string }).id;
                const complete = yield* connect.backend.applyAction({
                    id: "complete",
                    name: "completeAuthorization",
                    parameters: { callbackUrl: `https://app.example/callback?state=${attempt}&code=one-use` },
                });
                const oauthId = (complete.result as { connectionId: string }).connectionId;
                const oauth = yield* open(`OAuthConnection/${oauthId}`);
                expect((yield* oauth.backend.loadSubset(objectSubset("Issue"))).rows).toHaveLength(1);
                const attached = yield* connect.backend.applyAction({
                    id: "attach",
                    name: "attachExternalSession",
                    parameters: { serviceInstanceId: "test", sessionId: "valid-session" },
                });
                const external = yield* open(
                    `ExternalSessionConnection/${(attached.result as { connectionId: string }).connectionId}`
                );
                expect((yield* external.backend.loadSubset(objectSubset("Issue"))).rows).toHaveLength(1);
                expect(sent).toContain("private-oauth-token");
                expect(sent).toContain("valid-session");
                const inventory = yield* connect.backend.loadSubset(objectSubset("OAuthConnection"));
                expect(JSON.stringify(inventory)).not.toContain("private-oauth-token");
                expect(JSON.stringify(inventory)).not.toContain("ciphertext");
                expect(
                    yield* Effect.result(
                        connect.backend.loadSubset(objectSubset("OAuthAuthorizationAttempt"))
                    )
                ).toMatchObject({ _tag: "Failure" });
            })
        )
    );
});
