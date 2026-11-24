import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { BackendError, projectBackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { o } from "@party-stack/ontology-spec";
import { field, selectField, sub } from "@party-stack/ontology-spec/query";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { MemoryRuntime, Runtimes } from "@party-stack/runtime";
import { Context, Deferred, Effect, Fiber, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import { makeReplica } from "../../ontology-replica/lib/service.js";
import { makeOntologyServer } from "./routing.js";
import { makeOntologyHttpClient, makeOntologyHttpHandler } from "./rpcHttp.js";
import { makeOntologyWorkerClient, serveOntologyWorker } from "./rpcWorker.js";
import type { ManagedReplicaRoute } from "./routing.js";
import type { Scope } from "effect";

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
const query = {
    select: [
        sub("issues", {
            from: { source: { objectType: "Issue" }, binding: "i" },
            select: [selectField("id", field("i", "id"))],
        }),
    ],
};
const setup = Effect.fnUntraced(function* (id: string) {
    const backend = yield* makeOwnedBackend({
        namespace: id,
        ir,
        tables: yield* Memory.make(),
        mutators: {},
    });
    yield* backend.storage.transaction((tx) => tx.put("Issue", { id }));
    return backend;
});

test("HTTP routing isolates ontologies and holds the resolved owner until a stream is cancelled", async () => {
    let active = 0;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const connect = yield* setup("connect");
                const issues = yield* setup("issues");
                const watching = yield* Deferred.make<void>();
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    resolve: (key) =>
                        Effect.gen(function* () {
                            if (key === "broken")
                                return yield* new BackendError({
                                    operation: "resolve",
                                    kind: "InvalidConfiguration",
                                    retryable: false,
                                    message: "The selected ontology has no context binding.",
                                });
                            if (key !== "connect" && key !== "issues")
                                return yield* new BackendError({
                                    operation: "resolve",
                                    kind: "NotFound",
                                    retryable: false,
                                    message: "Unknown ontology.",
                                });
                            yield* Effect.acquireRelease(
                                Effect.sync(() => {
                                    active++;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        active--;
                                    })
                            );
                            return {
                                kind: "owned" as const,
                                backend:
                                    key === "connect"
                                        ? connect
                                        : {
                                              ...issues,
                                              watchSubset: () =>
                                                  Deferred.succeed(watching, undefined).pipe(
                                                      Effect.as(Stream.never)
                                                  ),
                                          },
                                dangerouslyAllowInternalAccess: true as const,
                            };
                        }),
                }).pipe(
                    Effect.flatMap((router) => makeOntologyHttpHandler(router)),
                    Effect.map((handleRequest) => ({ handleRequest }))
                );
                yield* Effect.gen(function* () {
                    const first = yield* makeOntologyHttpClient({
                        url: "https://ontology.test/rpc",
                        ontology: "connect",
                    }).pipe(Effect.flatMap((server) => server.ontology()));
                    const second = yield* makeOntologyHttpClient({
                        url: "https://ontology.test/rpc",
                        ontology: "issues",
                    }).pipe(Effect.flatMap((server) => server.ontology()));
                    expect(first.sourceId).not.toBe(second.sourceId);
                    expect(yield* first.backend.query(query)).toEqual({ issues: [{ id: "connect" }] });
                    expect(yield* second.backend.query(query)).toEqual({ issues: [{ id: "issues" }] });
                    const unknown = yield* Effect.result(
                        makeOntologyHttpClient({
                            url: "https://ontology.test/rpc",
                            ontology: "missing",
                        }).pipe(Effect.flatMap((server) => server.ontology()))
                    );
                    expect(unknown).toMatchObject({ _tag: "Failure", failure: { kind: "NotFound" } });
                    const broken = yield* Effect.result(
                        makeOntologyHttpClient({ url: "https://ontology.test/rpc", ontology: "broken" }).pipe(
                            Effect.flatMap((server) => server.ontology())
                        )
                    );
                    expect(broken).toMatchObject({
                        _tag: "Failure",
                        failure: {
                            kind: "InvalidConfiguration",
                            retryable: false,
                            message: "The operation could not be completed.",
                        },
                    });
                    const watcher = yield* Stream.unwrap(
                        second.backend.watchSubset!(objectSubset("Issue"))!
                    ).pipe(Stream.scoped, Stream.runDrain, Effect.forkScoped);
                    yield* Deferred.await(watching);
                    expect(active).toBe(1);
                    expect(yield* second.backend.query(query)).toEqual({ issues: [{ id: "issues" }] });
                    expect(active).toBe(1);
                    yield* Fiber.interrupt(watcher);
                    yield* Effect.promise(() => vi.waitFor(() => expect(active).toBe(0)));
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        server.handleRequest(new Request(input, init))
                    )
                );
            })
        )
    );
    expect(active).toBe(0);
});

test("routing resolves a replacement native owner while an old subscription is still open", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const old = yield* setup("old");
                const next = yield* setup("next");
                const started = yield* Deferred.make<void>();
                const original = {
                    ...old,
                    watchSubset: () => Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never)),
                };
                let current = original;
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    resolve: () =>
                        Effect.succeed({
                            kind: "owned" as const,
                            backend: current,
                            dangerouslyAllowInternalAccess: true as const,
                        }),
                }).pipe(
                    Effect.flatMap((router) => makeOntologyHttpHandler(router)),
                    Effect.map((handleRequest) => ({ handleRequest }))
                );
                yield* Effect.gen(function* () {
                    const transport = yield* makeOntologyHttpClient({
                        url: "https://ontology.test/rpc",
                        ontology: "issues",
                    });
                    const client = yield* transport.ontology();
                    const watcher = yield* Stream.unwrap(
                        client.backend.watchSubset!(objectSubset("Issue"))!
                    ).pipe(Stream.scoped, Stream.runDrain, Effect.forkScoped);
                    yield* Deferred.await(started);
                    current = { ...next, watchSubset: original.watchSubset };
                    expect(yield* Effect.result(client.backend.query(query))).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "SourceMismatch" },
                    });
                    const replacement = yield* transport.ontology();
                    expect(yield* replacement.backend.query(query)).toEqual({ issues: [{ id: "next" }] });
                    yield* Fiber.interrupt(watcher);
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        server.handleRequest(new Request(input, init))
                    )
                );
            })
        )
    );
});

test("one worker routes ordinary clients and download controls to the selected replica", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("issues");
                const replica = yield* makeReplica({
                    namespace: "routed-owner",
                    ir,
                    backend,
                    tables: yield* Memory.make(),
                    live: false,
                });
                const channel = new MessageChannel();
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        channel.port1.close();
                        channel.port2.close();
                    })
                );
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    routes: {
                        issues: { kind: "replica", backend, replica, dangerouslyAllowInternalAccess: true },
                        other: {
                            kind: "owned",
                            backend: yield* setup("other"),
                            dangerouslyAllowInternalAccess: true,
                        },
                    },
                });
                yield* serveOntologyWorker(server).pipe(
                    Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1))
                );
                const root = yield* makeOntologyWorkerClient().pipe(
                    Effect.provide(BrowserWorker.layer(() => channel.port2))
                );
                const client = yield* root.ontology("issues");
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const other = yield* root.ontology("other");
                        expect(yield* other.backend.query(query)).toEqual({ issues: [{ id: "other" }] });
                    })
                );
                expect(yield* client.backend.query(query)).toEqual({ issues: [{ id: "issues" }] });
                expect(client.pinBackend).toBeDefined();
                const downloads = yield* client.pinBackend!;
                expect((yield* downloads.loadSubset(objectSubset("Pin"))).rows).toEqual([]);
                yield* downloads.applyAction({
                    id: "download",
                    name: "updatePins",
                    parameters: { change: { set: [{ name: "issues", query }] } },
                });
                expect(yield* replica.demand.pins.list).toMatchObject([
                    { name: "issues", attachments: "none" },
                ]);
                expect((yield* downloads.loadSubset(objectSubset("Pin"))).rows).toHaveLength(1);
                yield* downloads.applyAction({
                    id: "clear",
                    name: "updatePins",
                    parameters: { change: { clearName: "issues" } },
                });
                expect(yield* replica.demand.pins.list).toEqual([]);
            })
        )
    );
});

test("a shared HTTP client selects static and parameter routes without mixing contexts", async () => {
    const opened: string[] = [];
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const fixed = yield* setup("fixed");
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    routes: {
                        "issues/special": {
                            kind: "owned",
                            backend: fixed,
                            dangerouslyAllowInternalAccess: true,
                        },
                        "issues/:id": {
                            dangerouslyAllowInternalAccess: true,
                            open: ({ id }) =>
                                Effect.gen(function* () {
                                    expectTypeOf(id).toEqualTypeOf<string>();
                                    opened.push(id);
                                    return {
                                        kind: "owned" as const,
                                        backend: yield* setup(id),
                                    };
                                }),
                        },
                    },
                });
                const handler = yield* makeOntologyHttpHandler(server);
                yield* Effect.gen(function* () {
                    const root = yield* makeOntologyHttpClient({ url: "https://ontology.test/rpc" });
                    const [first, second, special] = yield* Effect.all(
                        [
                            root.ontology("issues/alice%2Fone"),
                            root.ontology("issues/bob"),
                            root.ontology("issues/special"),
                        ],
                        { concurrency: "unbounded" }
                    );
                    expect(
                        yield* Effect.all(
                            [
                                first.backend.query(query),
                                second.backend.query(query),
                                special.backend.query(query),
                            ],
                            { concurrency: "unbounded" }
                        )
                    ).toEqual([
                        { issues: [{ id: "alice/one" }] },
                        { issues: [{ id: "bob" }] },
                        { issues: [{ id: "fixed" }] },
                    ]);
                    yield* root.ontology("/issues/alice%2fone/");
                    expect(opened.sort()).toEqual(["alice/one", "bob"]);
                    expect(yield* Effect.result(root.ontology("missing"))).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "NotFound" },
                    });
                    expect(yield* Effect.result(root.ontology("issues/%zz"))).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "InvalidRequest" },
                    });
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handler(new Request(input, init))
                    )
                );
            })
        )
    );
});

test.each([["issues/:id", "issues/:other"], ["issues/*rest/more"], ["issues/:id/:id"]])(
    "invalid route tables fail during construction: %s",
    async (...patterns) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const backend = yield* setup("invalid");
                    const routes = Object.fromEntries(
                        patterns.map((pattern) => [
                            pattern,
                            {
                                kind: "owned" as const,
                                backend,
                                dangerouslyAllowInternalAccess: true as const,
                            },
                        ])
                    );
                    expect(
                        yield* Effect.result(makeOntologyServer({ enableRealtime: true, routes }))
                    ).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "InvalidConfiguration" },
                    });
                })
            )
        );
    }
);

test("literal routes infer all named and wildcard parameters", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("typed-params");
                const seen: unknown[] = [];
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    routes: {
                        "forms/:formId/revisions/:revisionId": {
                            dangerouslyAllowInternalAccess: true,
                            open: (params) => {
                                expectTypeOf(params).toEqualTypeOf<
                                    Readonly<{ formId: string; revisionId: string }>
                                >();
                                seen.push(params);
                                return Effect.succeed({
                                    kind: "owned",
                                    backend,
                                });
                            },
                        },
                        "assets/*path": {
                            dangerouslyAllowInternalAccess: true,
                            open: (params) => {
                                expectTypeOf(params).toEqualTypeOf<Readonly<{ path: string }>>();
                                seen.push(params);
                                return Effect.succeed({
                                    kind: "owned",
                                    backend,
                                });
                            },
                        },
                    },
                });
                yield* server.bind("forms/one/revisions/two");
                yield* server.bind("assets/a/b%20c");
                expect(seen).toEqual([{ formId: "one", revisionId: "two" }, { path: "a/b c" }]);
            })
        )
    );
});

test("a route that fails to open is opened again by the next request, not served from cache", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("retry");
                const release = yield* Deferred.make<void>();
                let opens = 0;
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    // The default 60 second retention: a cached failure would outlive the test.
                    routes: {
                        "issues/:id": {
                            dangerouslyAllowInternalAccess: true,
                            open: () =>
                                Effect.gen(function* () {
                                    const attempt = ++opens;
                                    if (attempt === 1) {
                                        yield* Deferred.await(release);
                                        return yield* new BackendError({
                                            operation: "test.open",
                                            kind: "Unavailable",
                                            retryable: true,
                                            message: "Schema load failed.",
                                        });
                                    }
                                    return {
                                        kind: "owned" as const,
                                        backend,
                                    };
                                }),
                        },
                    },
                });
                // Requests already waiting on the failing open share its failure.
                const waiting = yield* Effect.all(
                    [server.bind("issues/one"), server.bind("issues/one")].map((bind) =>
                        Effect.forkScoped(Effect.result(bind))
                    )
                );
                yield* Effect.yieldNow;
                yield* Deferred.succeed(release, undefined);
                for (const fiber of waiting)
                    expect(yield* Fiber.join(fiber)).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Unavailable" },
                    });
                expect(opens).toBe(1);
                // The next request opens the route again, and that success is kept.
                const bound = yield* server.bind("issues/one");
                expect(yield* bound.options.backend!.query(query)).toEqual({ issues: [{ id: "retry" }] });
                yield* server.bind("issues/one");
                expect(opens).toBe(2);
            })
        )
    );
});

const definitionFailure = () =>
    new BackendError({
        operation: "metadata.pull",
        kind: "InvalidConfiguration",
        retryable: false,
        message: "Pulled ontology is invalid: Unknown property.",
    });

test.each([
    [undefined, "The operation could not be completed."],
    [true as const, "Pulled ontology is invalid: Unknown property."],
])(
    "a route that fails to open reports its original error only to callers allowed internal access (%s)",
    async (dangerouslyAllowInternalAccess, message) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const server = yield* makeOntologyServer({
                        routes: {
                            broken: { dangerouslyAllowInternalAccess, open: () => definitionFailure() },
                        },
                    }).pipe(
                        Effect.flatMap((router) => makeOntologyHttpHandler(router)),
                        Effect.map((handleRequest) => ({ handleRequest }))
                    );
                    const result = yield* Effect.result(
                        makeOntologyHttpClient({ url: "https://ontology.test/rpc", ontology: "broken" }).pipe(
                            Effect.flatMap((client) => client.ontology())
                        )
                    ).pipe(
                        Effect.provide(FetchHttpClient.layer),
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            server.handleRequest(new Request(input, init))
                        )
                    );
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "InvalidConfiguration", message },
                    });
                })
            )
        );
    }
);

test("a route authenticates before it opens, and a predicate decides who sees open failures", async () => {
    let opens = 0;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* makeOntologyServer({
                    routes: {
                        broken: {
                            authenticate: (request) => {
                                const role = request.headers.get("role");
                                return role
                                    ? Effect.succeed({ role })
                                    : Effect.fail(
                                          new BackendError({
                                              operation: "test.authenticate",
                                              kind: "Unauthenticated",
                                              retryable: false,
                                              message: "No session.",
                                          })
                                      );
                            },
                            dangerouslyAllowInternalAccess: (context) => context.role === "admin",
                            open: () =>
                                Effect.suspend(() => {
                                    opens++;
                                    return definitionFailure();
                                }),
                        },
                    },
                    idleRetentionMs: 0,
                });
                const attempt = (headers: Record<string, string>) =>
                    server.bind("broken", new Request("https://ontology.test/rpc", { headers })).pipe(
                        Effect.mapError((error) => projectBackendError(error, server.errors)),
                        Effect.flip
                    );

                expect(yield* attempt({})).toMatchObject({ kind: "Unauthenticated" });
                expect(opens).toBe(0);
                expect(yield* attempt({ role: "admin" })).toMatchObject({
                    message: "Pulled ontology is invalid: Unknown property.",
                });
                expect(yield* attempt({ role: "member" })).toMatchObject({
                    message: "The operation could not be completed.",
                });
                expect(opens).toBe(2);
            })
        )
    );
});

test("replica routes require internal access for every caller", async () => {
    const result = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("replica-access");
                const server = yield* makeOntologyServer({
                    routes: {
                        items: {
                            dangerouslyAllowInternalAccess: () => true,
                            open: Effect.gen(function* () {
                                return {
                                    kind: "replica" as const,
                                    backend,
                                    replica: yield* makeReplica({
                                        namespace: "replica-access",
                                        ir,
                                        backend,
                                        tables: yield* Memory.make(),
                                        live: false,
                                    }),
                                };
                            }),
                        },
                    },
                });
                return yield* Effect.result(server.bind("items"));
            })
        )
    );
    expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
            kind: "InvalidConfiguration",
            message: "Replica routes require dangerouslyAllowInternalAccess: true.",
        },
    });
});

test("access and authentication are settings of the route, not of what it opens", () => {
    const backend = undefined as unknown as Effect.Success<ReturnType<typeof makeOwnedBackend>>;
    void (() =>
        makeOntologyServer({
            routes: {
                // @ts-expect-error Internal access is declared beside `open`, not returned by it.
                opened: {
                    dangerouslyAllowInternalAccess: true,
                    open: () =>
                        Effect.succeed({
                            kind: "owned" as const,
                            backend,
                            dangerouslyAllowInternalAccess: true as const,
                        }),
                },
            },
        }));
});

test("managed replica routes leave the protocol source and bootstrap to the server", () => {
    type Keys = ManagedReplicaRoute extends infer Route
        ? Route extends unknown
            ? keyof Route
            : never
        : never;
    expectTypeOf<Extract<Keys, "source" | "bootstrap">>().toEqualTypeOf<never>();
    expectTypeOf<Extract<Keys, "onDefinitionChange" | "ir" | "upstream">>().toEqualTypeOf<
        "onDefinitionChange" | "ir" | "upstream"
    >();
});

test("inferred route parameters preserve Effect service requirements", async () => {
    class Label extends Context.Service<Label, string>()("routing-test/Label") {}
    const open = makeOntologyServer({
        enableRealtime: true,
        replicas: {},
        routes: {
            "issues/:id": {
                dangerouslyAllowInternalAccess: true,
                open: ({ id }) =>
                    Effect.gen(function* () {
                        const label = yield* Label;
                        return {
                            kind: "owned" as const,
                            backend: yield* setup(`${id}-${label}`),
                        };
                    }),
            },
        },
    });
    expectTypeOf<Effect.Services<typeof open>>().toEqualTypeOf<Label | Scope.Scope>();
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const server = yield* open;
                const bound = yield* server.bind("issues/one");
                expect(yield* bound.options.backend!.query(query)).toEqual({ issues: [{ id: "one-label" }] });
            }).pipe(Effect.provideService(Label, "label"))
        )
    );
});

test.each([undefined, {}])("managed replica routes share one owner with replicas=%j", async (replicas) => {
    let acquired = 0;
    let available = true;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("managed");
                const open = makeOntologyServer({
                    enableRealtime: true,
                    replicas,
                    idleRetentionMs: 0,
                    routes: {
                        "issues/:id": {
                            dangerouslyAllowInternalAccess: true,
                            open: Effect.fnUntraced(function* ({ id }: Readonly<Record<string, string>>) {
                                acquired++;
                                if (!available)
                                    return yield* new BackendError({
                                        operation: "route",
                                        kind: "Unauthenticated",
                                        retryable: false,
                                        message: "Expired",
                                    });
                                return {
                                    kind: "replica" as const,
                                    backend,
                                    ir,
                                    namespace: `issues-${id}`,
                                };
                            }),
                        },
                    },
                });
                expectTypeOf<Effect.Services<typeof open>>().toEqualTypeOf<Runtimes | Scope.Scope>();
                const server = yield* open;
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const first = yield* server.bind("issues/one");
                        const second = yield* server.bind("/issues/one/");
                        expect(first.options.replica).toBe(second.options.replica);
                        expect(acquired).toBe(1);
                    })
                );
                available = false;
                expect(yield* server.partitions).toMatchObject([
                    { ontology: "issues/one", partition: { namespace: "issues-one" } },
                ]);
                yield* server.forget("issues/one");
                expect(acquired).toBe(1);
                expect(yield* server.partitions).toEqual([]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("managed replica scope prefixes a configured namespace after concrete route resolution", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("scoped");
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    replicas: { scope: "server:one" },
                    routes: {
                        "issues/:id": {
                            dangerouslyAllowInternalAccess: true,
                            open: ({ id }) =>
                                Effect.succeed({
                                    kind: "replica" as const,
                                    ir,
                                    backend,
                                    namespace: `cache:${id}`,
                                    live: false,
                                }),
                        },
                    },
                });
                const first = yield* server.bind("/issues/one/");
                const second = yield* server.bind("issues/one");
                expect(first.options.replica).toBe(second.options.replica);
                expect(yield* server.partitions).toMatchObject([
                    {
                        ontology: "issues/one",
                        partition: {
                            owner: "anonymous",
                            namespace: JSON.stringify(["replica-scope", "server:one", "cache:one"]),
                        },
                    },
                ]);
            }).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
        )
    );
});

test("server rejects an explicitly empty replica scope", async () => {
    expect(
        await Effect.runPromise(
            Effect.scoped(
                Effect.result(
                    makeOntologyServer({ enableRealtime: true, replicas: { scope: "" }, routes: {} })
                ).pipe(Effect.provide(Runtimes.layer(MemoryRuntime.layer)))
            )
        )
    ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidConfiguration" } });
});

test("subscriptions on a shared worker client do not starve ordinary calls", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup("shared");
                const ready = yield* Deferred.make<void>();
                let watching = 0;
                const server = yield* makeOntologyServer({
                    enableRealtime: true,
                    kind: "owned",
                    dangerouslyAllowInternalAccess: true,
                    backend: {
                        ...backend,
                        watchSubset: () =>
                            Effect.gen(function* () {
                                if (++watching === 70) yield* Deferred.succeed(ready, undefined);
                                return Stream.never;
                            }),
                    },
                });
                const channel = new MessageChannel();
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        channel.port1.close();
                        channel.port2.close();
                    })
                );
                yield* serveOntologyWorker(server).pipe(
                    Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1))
                );
                const root = yield* makeOntologyWorkerClient().pipe(
                    Effect.provide(BrowserWorker.layer(() => channel.port2))
                );
                const selected = yield* root.ontology();
                yield* Effect.forEach(
                    Array.from({ length: 70 }),
                    () =>
                        Stream.unwrap(selected.backend.watchSubset!(objectSubset("Issue"))!).pipe(
                            Stream.scoped,
                            Stream.runDrain,
                            Effect.forkScoped
                        ),
                    { discard: true }
                );
                yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
                expect(yield* (yield* root.ontology()).backend.query(query)).toEqual({
                    issues: [{ id: "shared" }],
                });
            })
        )
    );
});
