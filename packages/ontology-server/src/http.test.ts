import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { CurrentExecutionContext } from "@party-stack/ontology-backend/policy";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { make } from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, test, vi } from "vite-plus/test";
import { makeOntologyServer, OntologyHttpServer, toWebHandler } from "./http.js";
import { makeOntologyHttpClient } from "./rpcHttp.js";

test.each([false, true])(
    "the Web binding owns requests and streaming scopes (authenticate: %s)",
    async (authenticated) => {
        let opened = 0;
        let closed = 0;
        let cancelled = 0;
        let hold = false;
        let authenticating = 0;
        const entered = Effect.runSync(Deferred.make<void>());
        const ir = {
            types: [],
            linkTypes: [],
            actionTypes: [],
            queryFunctionTypes: [],
            objectTypes: [
                {
                    name: "Issue",
                    displayName: "Issue",
                    pluralDisplayName: "Issues",
                    primaryKey: "id",
                    properties: [{ name: "id", displayName: "ID", type: o.string({}) }],
                },
            ],
        };
        const layer = OntologyHttpServer.layer(
            Effect.gen(function* () {
                opened++;
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        closed++;
                    })
                );
                const owned = yield* makeOwnedBackend({
                    namespace: "web-layer",
                    ir,
                    tables: yield* make(),
                    mutators: {},
                });
                return yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "owned",
                    backend: {
                        ...owned,
                        watchSubset: () =>
                            Effect.succeed(Stream.concat(Stream.succeed(undefined), Stream.never)),
                        loadSubset: (subset) =>
                            hold
                                ? Effect.acquireUseRelease(
                                      Deferred.succeed(entered, undefined),
                                      () => Effect.never,
                                      () =>
                                          Effect.sync(() => {
                                              cancelled++;
                                          })
                                  )
                                : owned.loadSubset(subset),
                    },
                    dangerouslyAllowInternalAccess: true,
                    ...(authenticated
                        ? {
                              authenticate: () =>
                                  Effect.acquireRelease(
                                      Effect.sync(() => {
                                          authenticating++;
                                          return {};
                                      }),
                                      () =>
                                          Effect.sync(() => {
                                              authenticating--;
                                          })
                                  ),
                          }
                        : {}),
                });
            })
        );
        const server = toWebHandler(layer);
        try {
            await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* makeOntologyHttpClient({
                            url: "https://ontology.test/rpc",
                        })
                            .pipe(Effect.flatMap((server) => server.ontology()))
                            .pipe(
                                Effect.provide(FetchHttpClient.layer),
                                Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                                    server.handler(new Request(input, init))
                                )
                            );
                        expect((yield* client.backend.loadSubset(objectSubset("Issue"))).rows).toEqual([]);
                        expect(opened).toBe(1);
                        expect(closed).toBe(0);
                        hold = true;
                        const request = yield* Effect.forkScoped(
                            client.backend.loadSubset(objectSubset("Issue"))
                        );
                        yield* Deferred.await(entered);
                        yield* Fiber.interrupt(request);
                        yield* Effect.promise(() => vi.waitFor(() => expect(cancelled).toBe(1)));
                        yield* Effect.promise(() => vi.waitFor(() => expect(authenticating).toBe(0)));
                        hold = false;
                        const watchScope = yield* Scope.fork(yield* Effect.scope);
                        yield* Scope.provide(client.backend.watchSubset!(objectSubset("Issue"))!, watchScope);
                        expect(authenticating).toBe(authenticated ? 1 : 0);
                        yield* Scope.close(watchScope, Exit.void);
                        yield* Effect.promise(() => vi.waitFor(() => expect(authenticating).toBe(0)));
                    })
                )
            );
        } finally {
            await server.dispose();
        }
        expect(closed).toBe(1);
    }
);

test.each(["predicate", "flag"] as const)(
    "internal access (%s) preserves policy and concurrent caller bindings",
    async (access) => {
        const { unauthenticated } = await import("@party-stack/ontology-backend");
        const q = await import("@party-stack/ontology-spec/query");
        const ir = {
            types: [],
            linkTypes: [],
            queryFunctionTypes: [
                { name: "actor", displayName: "Actor", parameters: [], returnType: o.string({}) },
            ],
            context: {
                type: o.struct({
                    fields: [
                        { name: "user", displayName: "User", type: o.string({}) },
                        { name: "role", displayName: "Role", type: o.string({}) },
                    ],
                }),
                partition: [["user"]],
            },
            objectTypes: [
                {
                    name: "Note",
                    displayName: "Note",
                    pluralDisplayName: "Notes",
                    primaryKey: "id",
                    properties: ["id", "owner", "secret"].map((name) => ({
                        name,
                        displayName: name,
                        type: o.string({}),
                    })),
                },
            ],
            actionTypes: [
                {
                    name: "create",
                    displayName: "Create",
                    parameters: [
                        { name: "id", displayName: "ID", type: o.string({}) },
                        { name: "owner", displayName: "Owner", type: o.string({}) },
                    ],
                    logic: [],
                },
            ],
            policy: {
                queryFunctions: [{ queryFunctionType: "actor", check: q.literal(true) }],
                objects: {
                    select: [
                        q.sub("notes", {
                            from: { source: { objectType: "Note" }, binding: "n" },
                            where: q.eq(q.field("n", "owner"), q.context("user")),
                            select: [
                                q.selectField("id", q.field("n", "id")),
                                q.selectField("owner", q.field("n", "owner")),
                            ],
                        }),
                    ],
                },
                actions: [
                    {
                        actionType: "create",
                        check: q.ne(q.input("id"), q.literal("forbidden")),
                        bind: [{ parameter: "owner", expression: q.context("user") }],
                    },
                ],
            },
        };
        let opened = 0,
            authentications = 0,
            active = 0,
            internalCalls = 0;
        const server = toWebHandler(
            OntologyHttpServer.layer(
                Effect.gen(function* () {
                    opened++;
                    const owned = yield* makeOwnedBackend({
                        namespace: "authenticated-http",
                        ir,
                        tables: yield* make(),
                        mutators: {
                            create: (tx, request) =>
                                tx.put("Note", {
                                    id: request.parameters.id,
                                    owner: request.parameters.owner,
                                    secret: "private",
                                }),
                        },
                        queryFunctions: {
                            actor: () =>
                                Effect.map(CurrentExecutionContext, (context) => context?.user ?? "none"),
                        },
                    });
                    yield* owned.storage.transaction((tx) =>
                        Effect.forEach(
                            ["alice", "bob"],
                            (user) => tx.put("Note", { id: user, owner: user, secret: `secret-${user}` }),
                            { discard: true }
                        )
                    );
                    return yield* makeOntologyServer({
                        enableRealtime: true,
                        kind: "owned",
                        backend: owned,
                        authenticate: Effect.fnUntraced(function* (request: Request) {
                            authentications++;
                            const user = request.headers.get("x-user");
                            if (!user) return yield* unauthenticated();
                            yield* Effect.acquireRelease(
                                Effect.sync(() => {
                                    active++;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                            );
                            return { user, role: request.headers.get("x-role") ?? "user" };
                        }),
                        dangerouslyAllowInternalAccess:
                            access === "flag" ? true : (context) => context.role === "admin",
                        deleteLocalData: Effect.sync(() => {
                            internalCalls++;
                        }),
                    });
                })
            )
        );
        const as = <A>(
            user: string,
            role: string,
            work: (
                client: Effect.Success<
                    ReturnType<Effect.Success<ReturnType<typeof makeOntologyHttpClient>>["ontology"]>
                >
            ) => Effect.Effect<A, unknown>
        ) =>
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* makeOntologyHttpClient({ url: "https://ontology.test/rpc" }).pipe(
                        Effect.flatMap((server) => server.ontology())
                    );
                    expect(client.context?.user).toBe(user);
                    return yield* work(client);
                })
            ).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
                    const request = new Request(input, init);
                    request.headers.set("x-user", user);
                    request.headers.set("x-role", role);
                    return server.handler(request);
                })
            );
        try {
            const denied = await server.handler(new Request("https://ontology.test/rpc", { method: "POST" }));
            expect(denied.status).toBe(401);
            expect(await denied.json()).toMatchObject({ kind: "Unauthenticated" });
            const unauthorized = await Effect.runPromise(
                Effect.scoped(
                    makeOntologyHttpClient({ url: "https://ontology.test/rpc" })
                        .pipe(Effect.flatMap((server) => server.ontology()))
                        .pipe(
                            Effect.provide(FetchHttpClient.layer),
                            Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                                server.handler(new Request(input, init))
                            )
                        )
                ).pipe(Effect.result)
            );
            expect(unauthorized).toMatchObject({ _tag: "Failure", failure: { kind: "Unauthenticated" } });
            await Effect.runPromise(
                Effect.all(
                    ["alice", "bob"].map((user) =>
                        as(user, "user", (client) =>
                            Effect.gen(function* () {
                                expect(yield* client.backend.queryFunction("actor", {})).toBe(user);
                                expect(client.ir!.objectTypes[0]!.properties.map((p) => p.name)).toEqual([
                                    "id",
                                    "owner",
                                ]);
                                expect((yield* client.backend.loadSubset(objectSubset("Note"))).rows).toEqual(
                                    [{ key: user, value: { id: user, owner: user } }]
                                );
                                yield* client.backend.applyAction({
                                    id: "same-id-per-caller",
                                    name: "create",
                                    parameters: { id: `new-${user}` },
                                });
                                expect(
                                    (yield* client.backend.loadSubset(objectSubset("Note"))).rows.map(
                                        (row) => row.value.owner
                                    )
                                ).toEqual([user, user]);
                                const control = yield* Effect.result(client.operations.deleteLocalData);
                                expect(control).toMatchObject(
                                    access === "flag"
                                        ? { _tag: "Success" }
                                        : { _tag: "Failure", failure: { kind: "NotFound" } }
                                );
                                // Public projected descriptions must not expose raw journals or speculative state.
                                expect(client.backend.changes).toBeUndefined();
                            })
                        )
                    ),
                    { concurrency: "unbounded" }
                )
            );
            await Effect.runPromise(
                as("alice", "admin", (client) =>
                    Effect.gen(function* () {
                        expect(yield* client.backend.queryFunction("actor", {})).toBe("alice");
                        expect(client.ir!.objectTypes[0]!.properties.map((p) => p.name)).toEqual([
                            "id",
                            "owner",
                        ]);
                        expect(client.ir!.actionTypes[0]!.parameters.map((p) => p.name)).toEqual(["id"]);
                        expect((yield* client.backend.loadSubset(objectSubset("Note"))).rows).toEqual([
                            { key: "alice", value: { id: "alice", owner: "alice" } },
                            { key: "new-alice", value: { id: "new-alice", owner: "alice" } },
                        ]);
                        expect(client.backend.changes).toBeUndefined();
                        expect(client.backend.subscribeSelection).toBeUndefined();
                        expect(client.replication.kind).toBe("committed");
                        const rejected = yield* Effect.result(
                            client.backend.applyAction({
                                id: "forbidden-action",
                                name: "create",
                                parameters: { id: "forbidden" },
                            })
                        );
                        expect(rejected).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound" } });
                        yield* client.backend.applyAction({
                            id: "admin-action",
                            name: "create",
                            parameters: { id: "admin-new", owner: "bob" },
                        });
                        const rows = (yield* client.backend.loadSubset(objectSubset("Note"))).rows;
                        expect(rows).toHaveLength(3);
                        expect(rows.find((row) => row.key === "admin-new")?.value).toEqual({
                            id: "admin-new",
                            owner: "alice",
                        });
                        yield* client.operations.deleteLocalData;
                    })
                )
            );
            expect(internalCalls).toBe(access === "flag" ? 3 : 1);
            expect(opened).toBe(1);
            expect(authentications).toBeGreaterThan(4);
            await vi.waitFor(() => expect(active).toBe(0));
        } finally {
            await server.dispose();
        }
    }
);

test("disposing the HTTP owner cancels authentication still waiting before response headers", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    let active = 0;
    const server = toWebHandler(
        OntologyHttpServer.layer(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "auth-owner-close",
                    ir: {
                        types: [],
                        objectTypes: [],
                        linkTypes: [],
                        actionTypes: [],
                        queryFunctionTypes: [],
                    },
                    tables: yield* make(),
                    mutators: {},
                });
                return yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "owned",
                    backend,
                    dangerouslyAllowInternalAccess: true,
                    authenticate: () =>
                        Effect.gen(function* () {
                            yield* Effect.acquireRelease(
                                Effect.sync(() => {
                                    active++;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                            );
                            yield* Deferred.succeed(entered, undefined);
                            return yield* Effect.never;
                        }),
                });
            })
        )
    );
    const response = server.handler(new Request("https://ontology.test/rpc", { method: "POST" }));
    try {
        await Effect.runPromise(Deferred.await(entered));
        expect(active).toBe(1);
        await server.dispose();
        await vi.waitFor(() => expect(active).toBe(0));
        expect(await response).toBeInstanceOf(Response);
    } finally {
        await server.dispose();
    }
});

test.each(["missing-context", "async-internal-access", "auth-defect"] as const)(
    "HTTP access fails closed for %s configuration",
    async (failure) => {
        const server = toWebHandler(
            OntologyHttpServer.layer(
                Effect.gen(function* () {
                    const ir = {
                        types: [],
                        objectTypes: [],
                        linkTypes: [],
                        actionTypes: [],
                        queryFunctionTypes: [],
                        context: { type: o.struct({ fields: [] }) },
                        policy: { objects: { select: [] } },
                    };
                    const backend = yield* makeOwnedBackend({
                        namespace: failure,
                        ir,
                        tables: yield* make(),
                        mutators: {},
                    });
                    return yield* makeOntologyServer({
                        enableRealtime: true,
                        kind: "owned",
                        backend,
                        authenticate: () =>
                            failure === "auth-defect"
                                ? Effect.die(new Error("private-session-token"))
                                : Effect.succeed(
                                      failure === "missing-context"
                                          ? (undefined as unknown as Record<string, unknown>)
                                          : {}
                                  ),
                        ...(failure === "async-internal-access"
                            ? {
                                  dangerouslyAllowInternalAccess: () =>
                                      Promise.resolve(true) as unknown as boolean,
                              }
                            : {}),
                    });
                })
            )
        );
        try {
            const response = await server.handler(
                new Request("https://ontology.test/rpc", { method: "POST" })
            );
            expect(response.status).toBe(500);
            const body = await response.text();
            expect(body).not.toContain("private-session-token");
            expect(JSON.parse(body).kind).toBe(
                failure === "auth-defect" ? "Internal" : "InvalidConfiguration"
            );
        } finally {
            await server.dispose();
        }
    }
);
