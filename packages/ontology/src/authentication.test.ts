import { connectDeviceRoute, makeConnectManager } from "@party-stack/connect";
import { BackendError, unauthenticated } from "@party-stack/ontology-backend";
import { makeOntologyServer } from "@party-stack/ontology-server";
import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";
import { MemoryBlobBytesStore, MemoryRuntime, Runtime, Runtimes } from "@party-stack/runtime";
import { makeTestRuntime } from "@party-stack/runtime/testing";
import { createLiveQueryCollection } from "@tanstack/db";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { authenticationObjects, createAuthenticationClient } from "./authentication.js";
import { httpClient } from "./http.js";
import { makeLiveOntology } from "./live/LiveOntology.js";
import type { ConnectOntology } from "@party-stack/connect/spec";
import type { OntologyServerClient } from "@party-stack/ontology-server/rpc";

test.each([false, true])(
    "authentication commands update a mounted descriptor account query without an outbox (lost reply: %s)",
    async (loseReply) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const key = yield* Effect.promise(() =>
                        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
                            "encrypt",
                            "decrypt",
                        ])
                    );
                    const runtime = yield* makeTestRuntime({
                        owner: "device",
                        namespace: "connect-sync",
                        blobBytes: new MemoryBlobBytesStore(),
                        encryptionKeyring: Effect.succeed({
                            active: Effect.succeed({ id: "key", key }),
                            get: () => Effect.succeed(key),
                        }),
                    });
                    let verifications = 0;
                    const manager = yield* makeConnectManager({
                        startMaintenance: false,
                        services: [
                            {
                                connector: {
                                    service: "test",
                                    externalSession: () =>
                                        Effect.sync(() => {
                                            verifications++;
                                            return { userId: "alice", title: "Alice" };
                                        }),
                                    acquire: ({ handlers }) =>
                                        Effect.succeed({
                                            ...handlers,
                                            fetch: () => Effect.fail(unauthenticated("Session expired.")),
                                        }),
                                },
                                instances: [
                                    { id: "test", title: "Test", instanceUrl: "https://service.test" },
                                ],
                            },
                        ],
                    }).pipe(Effect.provideService(Runtime, runtime));
                    const server = yield* makeOntologyServer({
                        enableRealtime: true,
                        routes: {
                            connect: connectDeviceRoute(manager),
                        },
                    });
                    const handler = yield* makeOntologyHttpHandler(server);
                    const root = yield* httpClient("https://app.test/rpc", {
                        fetch: (input, init) => handler(new Request(input, init)),
                    });
                    const live = yield* makeLiveOntology<ConnectOntology>({
                        client: root,
                        ontology: "connect",
                    }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)));
                    const lostReply = new BackendError({
                        operation: "applyAction",
                        kind: "Unavailable",
                        retryable: true,
                        actionOutcome: "unknown",
                        message: "The command reply was lost after commit.",
                    });
                    // Only the command observer loses its reply. Subscription notifications
                    // still travel through the real server and HTTP transport.
                    const lostReplies = new Set<string>();
                    const commandsClient: OntologyServerClient = {
                        ontology: (name) =>
                            root.ontology(name).pipe(
                                Effect.map((client) => ({
                                    ...client,
                                    backend: {
                                        ...client.backend,
                                        applyAction: (request) =>
                                            client.backend.applyAction(request).pipe(
                                                Effect.flatMap((receipt) => {
                                                    if (
                                                        loseReply &&
                                                        [
                                                            "attachExternalSession",
                                                            "forgetExternalSession",
                                                        ].includes(request.name) &&
                                                        !lostReplies.has(request.name)
                                                    ) {
                                                        lostReplies.add(request.name);
                                                        return Effect.fail(lostReply);
                                                    }
                                                    return Effect.succeed(receipt);
                                                })
                                            ),
                                    },
                                }))
                            ),
                    };
                    const commands = yield* Effect.acquireRelease(
                        Effect.promise(() => createAuthenticationClient({ client: commandsClient })),
                        (client) => Effect.promise(() => client.cleanup())
                    );
                    const query = createLiveQueryCollection({
                        query: (q) =>
                            q
                                .from({
                                    account: live.dbClient.collection(
                                        authenticationObjects.ExternalSessionConnection
                                    ),
                                })
                                .select(({ account }) => ({
                                    kind: "external-session" as const,
                                    id: account.id,
                                    title: account.title,
                                    userId: account.userId,
                                    status: account.status,
                                })),
                        gcTime: 0,
                    });
                    yield* Effect.acquireRelease(
                        Effect.sync(() => query.subscribeChanges(() => {})),
                        (subscription) =>
                            Effect.promise(async () => {
                                subscription.unsubscribe();
                                await query.cleanup();
                            })
                    );
                    yield* Effect.promise(() => query.preload());
                    expect(query.toArray).toEqual([]);
                    yield* Effect.promise(async () => {
                        const submitting = commands.attachExternalSession("test", "verified-session");
                        if (loseReply) await expect(submitting).rejects.toThrow(lostReply.message);
                        else await submitting;
                        await vi.waitFor(() =>
                            expect(query.toArray).toMatchObject([
                                { userId: "alice", title: "Alice", status: "active" },
                            ])
                        );
                    });
                    expect(verifications).toBe(1);
                    expect(query.toArray[0]).not.toHaveProperty("sessionId");
                    expect(yield* live.replica.outbox.entries).toEqual([]);
                    const id = query.toArray[0]!.id;
                    const access = yield* manager.connections.acquire({
                        objectType: "ExternalSessionConnection",
                        id,
                    });
                    expect(yield* Effect.result(access.egress.fetch("https://service.test"))).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Unauthenticated" },
                    });
                    yield* Effect.promise(() =>
                        vi.waitFor(() => expect(query.toArray).toMatchObject([{ id, status: "needs-auth" }]))
                    );
                    expect(yield* manager.store.get("ExternalSessionConnection", id)).toMatchObject({
                        status: "needs-auth",
                    });
                    yield* Effect.promise(async () => {
                        await expect(commands.signOut(query.toArray[0]!)).resolves.toBeUndefined();
                        await vi.waitFor(() =>
                            expect(query.toArray).toMatchObject([{ id, status: "inactive" }])
                        );
                    });
                    yield* Effect.promise(async () => {
                        const forgetting = commands.forget(query.toArray[0]!);
                        if (loseReply) await expect(forgetting).rejects.toThrow(lostReply.message);
                        else await expect(forgetting).resolves.toBeUndefined();
                        await vi.waitFor(() => expect(query.toArray).toEqual([]));
                        await expect(commands.forget({ kind: "external-session", id })).rejects.toMatchObject(
                            {
                                kind: "ValidationFailed",
                                issues: expect.arrayContaining([
                                    {
                                        code: "InvalidObjectReference",
                                        path: ["connectionId"],
                                        message: expect.any(String),
                                    },
                                ]),
                            }
                        );
                        expect(await commands.connections()).toEqual([]);
                    });
                    expect(yield* manager.store.get("ExternalSessionConnection", id)).toBeUndefined();
                    expect(yield* live.replica.outbox.entries).toEqual([]);
                })
            )
        );
    }
);
