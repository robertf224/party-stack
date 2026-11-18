import { BackendError } from "@party-stack/ontology-backend";
import { o, validate } from "@party-stack/ontology-spec";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Clock, Effect } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vite-plus/test";
import { connectOntology } from "../spec/index.js";
import { connectionAccessToken } from "./accessToken.js";
import { makeConnectBackend } from "./backend.js";

test("Connect actions use journaled ontology state and return no credentials", async () => {
    expect(validate(connectOntology).kind).toBe("ok");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const key = yield* Effect.promise(() =>
                    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
                );
                const values = makeEncryptedValues("connect-backend", {
                    active: Effect.succeed({ id: "key", key }),
                    get: () => Effect.succeed(key),
                });
                let exchanges = 0;
                const { backend, store } = yield* makeConnectBackend({
                    tables,
                    namespace: "connect-backend",
                    values: { ...values, evict: () => Effect.void },
                    oauth: () =>
                        Effect.succeed({
                            authorizationUrl: ({ state }) =>
                                Effect.succeed(`https://auth.example/authorize?state=${state}`),
                            exchange: () =>
                                Effect.sync(() => {
                                    exchanges++;
                                    return {
                                        accessToken: "private-access",
                                        refreshToken: "private-refresh",
                                        userId: "oauth-user",
                                    };
                                }),
                            refresh: () =>
                                Effect.succeed({
                                    accessToken: "new-access",
                                    userId: "oauth-user",
                                }),
                            clientCredentials: Effect.succeed({
                                accessToken: "service-access",
                                userId: "oauth-user",
                            }),
                        }),
                });
                yield* store.transaction(
                    Effect.gen(function* () {
                        yield* store.put("ServiceInstance", {
                            id: "serviceInstance",
                            title: "Example",
                            service: "example",
                            instanceUrl: "https://example.com",
                        });
                        yield* store.put("OAuthApplication", {
                            id: "application",
                            title: "Example",
                            serviceInstance: "serviceInstance",
                            flow: "authorization-code",
                            clientId: "app",
                        });
                    })
                );
                const before = yield* backend.changes!.pull({});
                const begun = yield* backend.applyAction({
                    id: "begin-1",
                    name: "beginAuthorization",
                    parameters: {
                        applicationId: "application",
                        principalId: "principal",
                        redirectUrl: "https://app.example/callback",
                    },
                });
                const { id, authorizationUrl } = begun.result as { id: string; authorizationUrl: string };
                expect(authorizationUrl).toContain(id);
                const request = {
                    id: "complete-1",
                    name: "completeAuthorization",
                    parameters: {
                        callbackUrl: `https://app.example/callback?state=${id}&code=private-code`,
                        principalId: "principal",
                    },
                };
                const completed = yield* backend.applyAction(request);
                expect(completed.result).toMatchObject({ connectionId: expect.any(String) });
                expect(JSON.stringify(completed)).not.toMatch(
                    /private-access|private-refresh|private-code|codeVerifier/
                );
                expect((yield* backend.applyAction(request)).result).toEqual(completed.result);
                expect(exchanges).toBe(1);
                const connectionId = (completed.result as { connectionId: string }).connectionId;
                expect(yield* connectionAccessToken(backend, connectionId)).toBe("private-access");
                const denied = yield* Effect.result(
                    connectionAccessToken(
                        {
                            ...backend,
                            encrypted: {
                                decrypt: () =>
                                    Effect.fail(
                                        new BackendError({
                                            operation: "decrypt",
                                            kind: "Forbidden",
                                            retryable: false,
                                            message: "Denied",
                                        })
                                    ),
                            },
                        },
                        connectionId
                    )
                );
                expect(denied).toMatchObject({ _tag: "Failure", failure: { kind: "Forbidden" } });
                const connection = (yield* store.get("OAuthConnection", connectionId))!;
                yield* store.put("OAuthConnection", { ...connection, status: "needs-auth" });
                expect(yield* connectionAccessToken(backend, connectionId)).toBe("private-access");
                yield* store.put("OAuthConnection", {
                    ...connection,
                    accessTokenExpiresAt: Temporal.Instant.fromEpochMilliseconds(
                        (yield* Clock.currentTimeMillis) - 1
                    ),
                });
                expect(yield* connectionAccessToken(backend, connectionId)).toBe("new-access");
                const changes = yield* backend.changes!.pull({ cursor: before.cursor });
                expect(
                    changes.commits.some((commit) =>
                        commit.changes.some((change) => change.objectType === "OAuthConnection")
                    )
                ).toBe(true);
                expect(backend.supportsIdempotency).toBe(false);
                expect(backend).not.toHaveProperty("storage");
                const invalid = yield* Effect.result(
                    backend.applyAction({ id: "invalid", name: "beginAuthorization", parameters: {} })
                );
                expect(invalid).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed", actionOutcome: "not-committed" },
                });
            })
        )
    );
});

test("application workflows require declared actions and validate parameters and results", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const key = yield* Effect.promise(() =>
                    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
                );
                const values = {
                    ...makeEncryptedValues("workflow", {
                        active: Effect.succeed({ id: "key", key }),
                        get: () => Effect.succeed(key),
                    }),
                    evict: () => Effect.void,
                };
                const options = { tables, namespace: "workflow", values, maintenance: false as const };
                for (const name of ["undeclared", "beginAuthorization"]) {
                    expect(
                        yield* Effect.result(
                            makeConnectBackend({
                                ...options,
                                actionHandlers: { [name]: () => Effect.void },
                            })
                        )
                    ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
                }
                let calls = 0;
                const { backend } = yield* makeConnectBackend({
                    ...options,
                    ir: {
                        ...connectOntology,
                        actionTypes: [
                            ...connectOntology.actionTypes,
                            { name: "toString", displayName: "Unimplemented", parameters: [], logic: [] },
                            {
                                name: "workflow",
                                displayName: "Workflow",
                                parameters: [{ name: "name", displayName: "Name", type: o.string({}) }],
                                logic: [],
                                returnType: o.string({}),
                            },
                        ],
                    },
                    actionHandlers: {
                        workflow: (request) =>
                            Effect.sync(() => {
                                calls++;
                                return request.parameters.name === "invalid-result"
                                    ? 123
                                    : request.parameters.name;
                            }),
                    },
                });
                expect(
                    yield* Effect.result(backend.applyAction({ id: "bad", name: "workflow", parameters: {} }))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed", actionOutcome: "not-committed" },
                });
                expect(
                    yield* Effect.result(
                        backend.applyAction({ id: "inherited", name: "toString", parameters: {} })
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotImplemented", actionOutcome: "not-committed" },
                });
                expect(calls).toBe(0);
                expect(
                    yield* backend.applyAction({ id: "ok", name: "workflow", parameters: { name: "done" } })
                ).toMatchObject({ outcome: "committed", result: "done" });
                expect(
                    yield* Effect.result(
                        backend.applyAction({
                            id: "result",
                            name: "workflow",
                            parameters: { name: "invalid-result" },
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse" } });
                expect(calls).toBe(2);
            })
        )
    );
});
