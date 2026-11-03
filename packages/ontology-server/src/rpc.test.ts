import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { makeReplica } from "@party-stack/ontology-replica";
import { replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { ontologyDefinitionSignature } from "@party-stack/ontology-storage";
import { eq, field } from "@party-stack/ontology-storage";
import { collectByteBlob, digestBytes, type ByteInput } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcTest } from "effect/rpc";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { replicaController } from "../../ontology-replica/lib/internal.js";
import { makeOntologyServer } from "./composition.js";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import { connectOntologyBackendHttp, connectOntologyHttp, makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologyConnection } from "./rpc.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

const speculativeSource = (connection: OntologyConnection) => {
    if (connection.replication.kind !== "speculative") throw new Error("Expected speculative replication.");
    return connection.replication.source;
};
const holdDemand = Effect.fnUntraced(function* (stream: Stream.Stream<void, BackendError>) {
    const pull = yield* Stream.toPull(stream);
    yield* pull;
});

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Counter",
            displayName: "Counter",
            pluralDisplayName: "Counters",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "count", displayName: "Count", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [{ name: "increment", displayName: "Increment", logic: [], parameters: [] }],
};
const setup = Effect.fnUntraced(function* () {
    return yield* makeOwnedBackend({
        namespace: "rpc",
        ir,
        tables: yield* Memory.make(),
        mutators: {
            increment: (tx) =>
                Effect.gen(function* () {
                    const previous = yield* tx.get("Counter", "one");
                    yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                }),
        },
    });
});

const openParent = Effect.fnUntraced(function* (backend: Effect.Success<ReturnType<typeof setup>>) {
    const parent = yield* makeReplica({
        namespace: "rpc-parent",
        ir,
        tables: yield* Memory.make(),
        backend,
        mutators: {
            increment: (tx) =>
                Effect.gen(function* () {
                    const row = yield* tx.get("Counter", "one");
                    yield* tx.put("Counter", { id: "one", count: Number(row?.count ?? 0) + 1 });
                }),
        },
    });
    yield* parent.demand.acquire({ from: { source: { objectType: "Counter" }, binding: "row" } });
    return { parent, source: replicaStateSource(parent) };
});

test.each(["owned", "proxy", "cached-proxy", "replica"] as const)(
    "%s servers install finite Query execution without a custom handler",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* setup();
                    yield* owned.applyAction({ id: "seed", name: "increment", parameters: {} });
                    const reads = vi.spyOn(owned.storage, "read");
                    const cache = yield* makeReplica({
                        namespace: "query-cache",
                        ir,
                        tables: yield* Memory.make(),
                        backend: owned,

                        live: false,
                        cache: { objects: false },
                    });
                    const role =
                        kind === "owned"
                            ? { kind, backend: owned }
                            : kind === "proxy"
                              ? { kind, backend: owned, ir }
                              : kind === "cached-proxy"
                                ? { kind, backend: owned, cache }
                                : { kind, backend: owned, replica: cache };
                    const operations: string[] = [];
                    const { handleRequest } = yield* makeOntologyServer({
                        ...role,
                        errors: "forward",
                        authorize: (request) =>
                            Effect.sync(() => {
                                operations.push(request.operation);
                            }),
                    });
                    yield* Effect.gen(function* () {
                        const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                        const result = yield* connection.operations.query({
                            select: [
                                q.sub("counters", {
                                    from: { source: { objectType: "Counter" }, binding: "c" },
                                    where: q.eq(q.field("c", "id"), q.literal("one")),
                                    select: [
                                        q.selectField("id", q.field("c", "id")),
                                        q.selectField(
                                            "doubled",
                                            q.add(q.field("c", "count"), q.field("c", "count"))
                                        ),
                                    ],
                                }),
                            ],
                        });
                        expect(result).toEqual({ counters: [{ id: "one", doubled: 2 }] });
                        expect(operations).toContain("Query");
                        if (kind === "owned") expect(reads).toHaveBeenCalledTimes(1);
                    }).pipe(
                        Effect.provide(FetchHttpClient.layer),
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            handleRequest(new Request(input, init))
                        )
                    );
                })
            )
        );
    }
);

test("automatic finite queries reject incomplete source subsets", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "proxy",
                    ir,
                    errors: "forward",
                    authorize: () => Effect.void,
                    backend: { ...owned, loadSubset: () => Effect.succeed({ rows: [], complete: false }) },
                });
                yield* Effect.gen(function* () {
                    const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                    const result = yield* Effect.result(
                        connection.operations.query({
                            select: [
                                q.sub("counters", {
                                    from: { source: { objectType: "Counter" }, binding: "c" },
                                    select: [q.selectField("id", q.field("c", "id"))],
                                }),
                            ],
                        })
                    );
                    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse" } });
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
            })
        )
    );
});

test("domain RPC carries selected state, resumable ordered actions and acknowledgments", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { parent, source: parentSource } = yield* openParent(owned);
                const operations: string[] = [];
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            source: parentSource,
                            authorize: (request) =>
                                Effect.sync(() => {
                                    operations.push(request.operation);
                                }),
                        })
                    )
                );
                const source = yield* makeOntologyProtocolClient(client);
                const session = yield* speculativeSource(source).openClient();
                const view = {
                    generation: 1,
                    selection: {
                        subsets: [{ objectType: "Counter", query: { where: eq(field("id"), "one") } }],
                        actionIds: ["one"],
                    },
                };
                const request = {
                    session,
                    sequence: 1,
                    invocation: { id: "one", name: "increment", parameters: {} },
                    optimistic: true,
                    view,
                };
                yield* speculativeSource(source).submit(request);
                yield* parent.outbox.wait("one");
                const delivered = yield* speculativeSource(source).read(session, view);
                expect((yield* speculativeSource(source).submit(request)).state.objects).toEqual(
                    delivered.state.objects
                );
                expect(delivered.state.objects[0]?.base[0]?.value.count).toBe(1);
                expect(delivered.state.completed[0]?.receipt?.outcome).toBe("committed");
                yield* speculativeSource(source).acknowledge(
                    session,
                    delivered.state.revision,
                    delivered.client.deliveredThrough,
                    view.generation
                );
                expect(
                    (yield* speculativeSource(source).read(session, view)).state.completed[0]?.receipt
                        ?.operationId
                ).toBe("one");
                yield* speculativeSource(source).submit(request);
                expect((yield* owned.loadSubset(objectSubset("Counter"))).rows[0]?.value.count).toBe(1);
                const resumed = yield* speculativeSource(source).openClient(session.client);
                expect(resumed.acceptedThrough).toBe(1);
                expect(resumed.connectionId).not.toBe(session.connectionId);
                expect((yield* Effect.result(speculativeSource(source).read(session, view)))._tag).toBe(
                    "Failure"
                );
                expect(operations).toContain("Read");
                expect(operations).toContain("Acknowledge");
            })
        )
    );
});

test("speculative delivery checks its client session before acquiring upstream demand", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const loads = vi.spyOn(owned, "loadSubset");
                const parent = yield* makeReplica({
                    namespace: "delivery-admission",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,
                    live: false,
                });
                const source = replicaStateSource(parent);
                const session = yield* source.openClient();
                const result = yield* Effect.result(
                    Effect.scoped(
                        source.subscribe!(
                            { ...session, connectionId: "stale" },
                            {
                                generation: 1,
                                selection: { subsets: [{ objectType: "Counter" }], actionIds: [] },
                            }
                        )
                    )
                );
                expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "SessionReplaced" } });
                expect(loads).not.toHaveBeenCalled();
            })
        )
    );
});

test("incremental state delivery owns demand without a parallel Demand RPC", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                yield* owned.applyAction({ id: "seed", name: "increment", parameters: {} });
                const parent = yield* makeReplica({
                    namespace: "delivery-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,
                });
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            source: replicaStateSource(parent),
                            ir,
                            authorize: (request) =>
                                request.operation === "Demand"
                                    ? Effect.fail(
                                          new BackendError({
                                              operation: "Demand",
                                              kind: "Internal",
                                              retryable: false,
                                              message: "Unexpected separate demand lease.",
                                          })
                                      )
                                    : Effect.void,
                        })
                    )
                );
                const connection = yield* makeOntologyProtocolClient(client);
                const child = yield* makeReplica({
                    namespace: "delivery-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: speculativeSource(connection),
                });
                const consumer = yield* Scope.make();
                yield* Effect.addFinalizer(() => Scope.close(consumer, Exit.void));
                yield* Scope.provide(child.demand.acquire(objectSubset("Counter")), consumer);
                expect((yield* child.get("Counter", "one"))?.count).toBe(1);
                expect((yield* parent.status.get).demands.some((d) => d.references > 0)).toBe(true);
                yield* owned.applyAction({ id: "update", name: "increment", parameters: {} });
                yield* Effect.promise(() =>
                    vi.waitFor(async () =>
                        expect((await Effect.runPromise(child.get("Counter", "one")))?.count).toBe(2)
                    )
                );
                yield* Scope.close(consumer, Exit.void);
                yield* Effect.promise(() =>
                    vi.waitFor(async () =>
                        expect(
                            (await Effect.runPromise(parent.status.get)).demands.filter(
                                (d) => d.references > 0
                            )
                        ).toHaveLength(0)
                    )
                );
            })
        )
    );
});

test.each(["Unavailable", "Forbidden"] as const)(
    "Demand RPC exposes %s after readiness without transport retries",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* setup();
                    const { source } = yield* openParent(owned);
                    let attempts = 0,
                        ready = 0;
                    const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                        Effect.provide(
                            ontologyRpcHandlers({
                                source: {
                                    ...source,
                                    demand: () =>
                                        Stream.suspend(() => {
                                            attempts++;
                                            return Stream.concat(
                                                Stream.make(undefined),
                                                Stream.fail(
                                                    new BackendError({
                                                        operation: "Demand",
                                                        kind,
                                                        retryable: kind === "Unavailable",
                                                        message: "Disconnected.",
                                                    })
                                                )
                                            );
                                        }),
                                },
                                authorize: () => Effect.void,
                            })
                        )
                    );
                    const connection = yield* makeOntologyProtocolClient(client);
                    const result = yield* Effect.result(
                        Stream.runForEach(
                            speculativeSource(connection).demand({ objectType: "Counter" }),
                            () =>
                                Effect.sync(() => {
                                    ready++;
                                })
                        )
                    );
                    expect(ready).toBe(1);
                    expect(result).toMatchObject({ _tag: "Failure", failure: { kind } });
                    expect(attempts).toBe(1);
                })
            )
        );
    }
);

test("native HTTP advertises and transports read-only parameter resolution with portable values", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const operations: string[] = [];
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "owned",
                    backend: {
                        ...owned,
                        resolveActionParameters: (name, parameters) =>
                            Effect.succeed({
                                ...parameters,
                                name,
                                at: Temporal.Instant.from("2026-10-26T00:00:00Z"),
                            }),
                    },
                    authorize: (request) =>
                        Effect.sync(() => {
                            operations.push(request.operation);
                        }),
                });
                yield* Effect.gen(function* () {
                    const backend = yield* connectOntologyBackendHttp({ url: "https://ontology.test/rpc" });
                    expect(backend.resolveActionParameters).toBeDefined();
                    const result = yield* backend.resolveActionParameters!("increment", { count: 4 });
                    expect(result).toMatchObject({ name: "increment", count: 4 });
                    expect(String(result.at)).toBe("2026-10-26T00:00:00Z");
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
                expect(operations).toContain("ResolveActionParameters");
                expect(operations).not.toContain("ApplyAction");
                expect(yield* owned.storage.read((tx) => tx.get("Counter", "one"))).toBeUndefined();
            })
        )
    );
});

test("RPC demand leases and change subscriptions close with the client scope", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { source: parentSource } = yield* openParent(owned);
                let leases = 0;
                const source: OntologySource = {
                    ...parentSource,
                    demand: () =>
                        Stream.concat(
                            Stream.fromEffect(
                                Effect.acquireRelease(
                                    Effect.sync(() => {
                                        leases++;
                                    }),
                                    () =>
                                        Effect.sync(() => {
                                            leases--;
                                        })
                                )
                            ),
                            Stream.never
                        ).pipe(Stream.scoped),
                };
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(ontologyRpcHandlers({ source, authorize: () => Effect.void }))
                );
                const remote = yield* makeOntologyProtocolClient(client);
                const session = yield* speculativeSource(remote).openClient();
                const consumer = yield* Scope.make();
                yield* Scope.provide(
                    holdDemand(speculativeSource(remote).demand({ objectType: "Counter" })),
                    consumer
                );
                expect(leases).toBe(1);
                const initial = yield* Deferred.make<void>();
                let messages = 0;
                yield* Scope.provide(
                    Effect.gen(function* () {
                        const changes = yield* speculativeSource(remote).subscribeChanges;
                        yield* Effect.forkScoped(
                            Stream.runForEach(changes, () =>
                                Effect.gen(function* () {
                                    messages++;
                                    yield* Deferred.succeed(initial, undefined);
                                })
                            )
                        );
                    }),
                    consumer
                );
                yield* Deferred.await(initial);
                yield* owned.applyAction({ id: "other", name: "increment", parameters: {} });
                yield* Effect.promise(() => vi.waitFor(() => expect(messages).toBeGreaterThan(1)));
                yield* Scope.close(consumer, Exit.void);
                yield* Effect.promise(() => vi.waitFor(() => expect(leases).toBe(0)));
                expect(
                    (yield* speculativeSource(remote).read(session)).state.objects[0]?.base[0]?.value.count
                ).toBe(1);
            })
        )
    );
});

test("HTTP RPC preserves values/authentication and reacquires interrupted streaming leases", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { parent, source: parentSource } = yield* openParent(owned);
                let leases = 0;
                let acquisitions = 0;
                const special = {
                    large: 12345678901234567890n,
                    date: new Date("2026-10-20T00:00:00Z"),
                    day: Temporal.PlainDate.from("2026-10-20"),
                    nested: { tags: new Set(["one"]) },
                };
                const handler = yield* makeOntologyHttpHandler({
                    source: {
                        ...parentSource,
                        read: (session, view) =>
                            parentSource.read(session, view).pipe(
                                Effect.map((result) => ({
                                    ...result,
                                    state: {
                                        ...result.state,
                                        objects: result.state.objects.map((objects) => ({
                                            ...objects,
                                            base: objects.base.map((row) => ({
                                                ...row,
                                                value: { ...row.value, special },
                                            })),
                                        })),
                                    },
                                }))
                            ),
                        demand: () =>
                            Stream.concat(
                                Stream.fromEffect(
                                    Effect.acquireRelease(
                                        Effect.sync(() => {
                                            leases++;
                                            acquisitions++;
                                        }),
                                        () =>
                                            Effect.sync(() => {
                                                leases--;
                                            })
                                    )
                                ),
                                Stream.never
                            ).pipe(Stream.scoped),
                    },
                    authorize: (_request, headers) =>
                        headers.authorization === "Bearer test"
                            ? Effect.void
                            : Effect.fail(
                                  new BackendError({
                                      operation: "authorize",
                                      kind: "ValidationFailed",
                                      message: "Missing credentials.",
                                      retryable: false,
                                  })
                              ),
                });
                const program = Effect.gen(function* () {
                    const http = yield* HttpClient.HttpClient;
                    const remote = yield* connectOntologyHttp({
                        url: "https://ontology.test/rpc",
                    }).pipe(
                        Effect.provideService(
                            HttpClient.HttpClient,
                            HttpClient.mapRequest(
                                http,
                                HttpClientRequest.setHeader("authorization", "Bearer test")
                            )
                        )
                    );
                    const session = yield* speculativeSource(remote).openClient();
                    yield* speculativeSource(remote).submit({
                        session,
                        sequence: 1,
                        invocation: { id: "one", name: "increment", parameters: {} },
                        optimistic: true,
                    });
                    yield* parent.outbox.wait("one");
                    const state = yield* speculativeSource(remote).read(session);
                    expect(state.state.objects[0]?.base[0]?.value.special).toEqual(special);
                    const consumer = yield* Scope.make();
                    const child = yield* makeReplica({
                        namespace: "http-demand-reconnect",
                        ir,
                        tables: yield* Memory.make(),
                        source: speculativeSource(remote),
                        live: false,
                    });
                    yield* Scope.provide(child.demand.acquire(objectSubset("Counter")), consumer);
                    yield* Effect.promise(() =>
                        vi.waitFor(
                            () => {
                                expect(acquisitions).toBe(2);
                                expect(leases).toBe(1);
                            },
                            { timeout: 3_000 }
                        )
                    );
                    expect(
                        yield* Stream.runHead(yield* speculativeSource(remote).subscribeChanges)
                    ).toMatchObject({
                        value: undefined,
                    });
                    yield* Scope.close(consumer, Exit.void);
                    yield* Effect.promise(() => vi.waitFor(() => expect(leases).toBe(0)));
                    expect(
                        yield* Effect.result(connectOntologyHttp({ url: "https://ontology.test/rpc" }))
                    ).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "ValidationFailed", retryable: false },
                    });
                });
                let interruptDemand = true;
                yield* program.pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
                        const request = new Request(input, init);
                        const message = JSON.parse(await request.clone().text());
                        const response = await handler(request);
                        if (!interruptDemand || message.tag !== "Demand") return response;
                        interruptDemand = false;
                        // Deliver readiness, then cut the body without a terminal RPC frame.
                        return new Response(
                            response.body!.pipeThrough(
                                new TransformStream({
                                    transform(chunk, controller) {
                                        controller.enqueue(chunk);
                                        controller.terminate();
                                    },
                                })
                            ),
                            { headers: response.headers }
                        );
                    })
                );
            })
        )
    );
});

test("RPC authorization runs before source operations, including demand and change streams", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { source: parentSource } = yield* openParent(owned);
                const read = vi.fn(parentSource.read);
                const submit = vi.fn(parentSource.submit);
                const demand = vi.fn(parentSource.demand);
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            source: { ...parentSource, read, submit, demand },
                            authorize: (request) =>
                                request.operation === "Describe" || request.operation === "OpenClient"
                                    ? Effect.void
                                    : Effect.fail(
                                          new BackendError({
                                              operation: "authorize",
                                              kind: "ValidationFailed",
                                              message: "Not authorized.",
                                              retryable: false,
                                          })
                                      ),
                        })
                    )
                );
                const remote = yield* makeOntologyProtocolClient(client);
                const session = yield* speculativeSource(remote).openClient();
                expect(yield* Effect.result(speculativeSource(remote).read(session))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed" },
                });
                expect(
                    yield* Effect.result(
                        speculativeSource(remote).submit({
                            session,
                            sequence: 1,
                            invocation: { id: "one", name: "increment", parameters: {} },
                            optimistic: true,
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "ValidationFailed" } });
                expect(
                    yield* Effect.result(
                        holdDemand(speculativeSource(remote).demand({ objectType: "Counter" }))
                    )
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed" },
                });
                expect(
                    yield* Effect.result(Stream.runDrain(yield* speculativeSource(remote).subscribeChanges))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed" },
                });
                expect(read).not.toHaveBeenCalled();
                expect(submit).not.toHaveBeenCalled();
                expect(demand).not.toHaveBeenCalled();
            })
        )
    );
});

test("helper RPCs authorize independently, preserve values and bytes, and stream owner traces", async () => {
    const { createTraceCapture } = await import("@party-stack/runtime/tracing");
    const { Tracer } = await import("effect");
    const capture = createTraceCapture(500, undefined, false);
    const subscribed = Effect.runSync(Deferred.make<void>());
    const traces = {
        ...capture,
        subscribe: (listener: Parameters<typeof capture.subscribe>[0]) => {
            const unsubscribe = capture.subscribe(listener);
            Effect.runSync(Deferred.succeed(subscribed, undefined));
            return unsubscribe;
        },
    };
    const bytes = new Map<string, Blob>();
    const draft = vi.fn(
        (_parameters: Record<string, unknown>, _settings: { knownParameters?: readonly string[] }) =>
            Effect.succeed({ certain: false as const })
    );
    const operations: string[] = [];
    // Focus this fixture on the real HTTP helper boundary; replica transfer has its own conformance tests.
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { source: parentSource } = yield* openParent(owned);
                const backend = {
                    ...owned,
                    queryFunction: (_name: string, parameters: Record<string, unknown>) =>
                        Effect.succeed(parameters),
                    validateAction: (
                        _name: string,
                        parameters: Record<string, unknown>,
                        settings?: { knownParameters?: readonly string[] }
                    ) =>
                        settings?.knownParameters
                            ? draft(parameters, settings)
                            : Effect.succeed({
                                  certain: true as const,
                                  value: { kind: "ok" as const, value: undefined },
                              }),
                    attachments: {
                        stage: (handle: { id: string }, input: ByteInput) =>
                            collectByteBlob(input).pipe(
                                Effect.map((blob) => {
                                    bytes.set(handle.id, blob);
                                    return { ...handle, type: blob.type };
                                }),
                                Effect.mapError(
                                    (cause) =>
                                        new BackendError({
                                            operation: "attachment.stage",
                                            kind: "Internal",
                                            message: "Failed upload",
                                            retryable: false,
                                            cause,
                                        })
                                )
                            ),
                        read: (handle: { id: string }) => Effect.succeed(bytes.get(handle.id)!),
                        metadata: (handle: { id: string }) =>
                            Effect.succeed({
                                size: bytes.get(handle.id)!.size,
                                type: bytes.get(handle.id)!.type,
                            }),
                    },
                };
                const replica = yield* makeReplica({
                    namespace: "inspect-owner",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,

                    live: false,
                    cache: { objects: false },
                });
                const handler = yield* makeOntologyHttpHandler({
                    source: parentSource,
                    replica,
                    backend,
                    traces,
                    authorize: (request) =>
                        Effect.sync(() => {
                            operations.push(request.operation);
                        }),
                });
                const client = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handler(new Request(input, init))
                    )
                );
                expect(yield* Effect.result(client.operations.deleteLocalData)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotImplemented" },
                });
                const date = Temporal.PlainDate.from("2026-10-20");
                expect(yield* client.operations.queryFunction("echo", { date })).toEqual({ date });
                expect(yield* client.operations.validate("action", {})).toEqual({
                    certain: true,
                    value: { kind: "ok", value: undefined },
                });
                expect(yield* client.operations.validate("action", {}, [])).toEqual({
                    certain: false,
                });
                expect(draft).toHaveBeenCalledWith({}, { knownParameters: [] });
                const { attachment } = yield* client.operations.attachments.create(
                    new Blob([new Uint8Array([0, 255, 127])], { type: "application/octet-stream" })
                );
                const received = yield* client.operations.attachments.blob(attachment);
                expect(new Uint8Array(yield* Effect.promise(() => received.arrayBuffer()))).toEqual(
                    new Uint8Array([0, 255, 127])
                );
                expect(yield* client.operations.attachments.metadata(attachment)).toMatchObject({
                    size: 3,
                    type: "application/octet-stream",
                });
                // The facade reads upload streams, including a source emitting a single large chunk.
                const data = new Uint8Array(150_000).map((_, index) => index % 251);
                const large = new Blob([data], { type: "application/octet-stream" });
                const materialize = vi.fn(() => Promise.reject(new Error("Whole upload read forbidden")));
                Object.defineProperty(large, "arrayBuffer", { value: materialize });
                Object.defineProperty(large, "stream", {
                    value: () =>
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(data);
                                controller.close();
                            },
                        }),
                });
                const big = yield* client.operations.attachments.create(large, { id: "large" });
                expect(materialize).not.toHaveBeenCalled();
                const downloaded = yield* client.operations.attachments.blob(big.attachment);
                expect(new Uint8Array(yield* Effect.promise(() => downloaded.arrayBuffer()))).toEqual(data);
                const empty = yield* client.operations.attachments.create(new Blob([]), { id: "empty" });
                expect((yield* client.operations.attachments.blob(empty.attachment)).size).toBe(0);
                expect(operations).not.toContain("ReplicaStatus");
                const stopMonitoring = client.operations.replicaMonitor.subscribe(() => undefined);
                yield* Effect.addFinalizer(() => Effect.sync(stopMonitoring));
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(client.operations.replicaMonitor.getSnapshot().status).toMatchObject({
                            sourceId: replica.sourceId,
                            mode: "adapter",
                            demands: [],
                            loadCount: 0,
                        })
                    )
                );
                // Inspecting the owner does not acquire demand or call the backend.
                expect((yield* replica.status.get).loadCount).toBe(0);
                const unsubscribe = client.operations.traces.subscribe(() => undefined);
                yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
                yield* Deferred.await(subscribed);
                yield* Effect.gen(function* () {
                    const span = yield* Effect.currentSpan;
                    span.event("replica.invalidation", 1_000_000n, {
                        diagnostic: true,
                        count: 3,
                        token: "secret",
                    });
                }).pipe(
                    Effect.withSpan("Replica.owner", { attributes: { activity: "subscription" } }),
                    Effect.provideService(Tracer.Tracer, traces.tracer)
                );
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(
                            client.operations.traces
                                .getSnapshot()
                                .some((trace) => trace.name === "Replica.owner")
                        ).toBe(true)
                    )
                );
                expect(
                    client.operations.traces.getSnapshot().find((trace) => trace.name === "Replica.owner")
                ).toMatchObject({
                    attributes: { activity: "subscription" },
                    eventCount: 1,
                    events: [{ name: "replica.invalidation", at: 1, attributes: { count: 3 } }],
                });
                yield* Effect.exit(
                    Effect.interrupt.pipe(
                        Effect.withSpan("stopped"),
                        Effect.provideService(Tracer.Tracer, traces.tracer)
                    )
                );
                yield* Effect.exit(
                    Effect.fail(new Error("Connection refused")).pipe(
                        Effect.withSpan("failed"),
                        Effect.provideService(Tracer.Tracer, traces.tracer)
                    )
                );
                yield* Effect.promise(() =>
                    vi.waitFor(() => {
                        expect(
                            client.operations.traces.getSnapshot().find((trace) => trace.name === "stopped")
                        ).toMatchObject({ outcome: "interrupted" });
                        expect(
                            client.operations.traces.getSnapshot().find((trace) => trace.name === "failed")
                        ).toMatchObject({
                            outcome: "failure",
                            error: { kind: "Error", message: "Connection refused" },
                        });
                    })
                );
                client.operations.traces.clear();
                expect(traces.getSnapshot()).toEqual([]);
                yield* Effect.promise(() =>
                    vi.waitFor(() => expect(client.operations.traces.getSnapshot()).toEqual([]))
                );
                expect(operations).toEqual(
                    expect.arrayContaining([
                        "QueryFunction",
                        "ValidateAction",
                        "CreateAttachment",
                        "ReadAttachment",
                        "AttachmentMetadata",
                        "Traces",
                        "ReplicaStatus",
                    ])
                );
            })
        )
    );
});

test("stateless backend calls use the same HTTP server without opening a replica session", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const operations: string[] = [];
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "proxy",
                    backend: owned,
                    ir,
                    errors: "forward",
                    authorize: (request) =>
                        Effect.sync(() => {
                            operations.push(request.operation);
                        }),
                });
                yield* Effect.gen(function* () {
                    const backend = yield* connectOntologyBackendHttp({ url: "https://ontology.test/rpc" });
                    const receipt = yield* backend.applyAction({
                        id: "stateless",
                        name: "increment",
                        parameters: {},
                    });
                    expect(receipt.outcome).toBe("committed");
                    const snapshot = yield* backend.loadSubset(objectSubset("Counter"));
                    expect(snapshot.rows[0]?.value.count).toBe(1);
                    expect(yield* backend.validateAction!("increment", {})).toEqual({ certain: false });
                    const changes = yield* backend.changes!.pull({});
                    expect(changes.commits.flatMap((commit) => commit.changes)).toContainEqual({
                        kind: "put",
                        objectType: "Counter",
                        key: "one",
                        value: { id: "one", count: 1 },
                    });
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
                expect(operations).toEqual([
                    "Describe",
                    "ApplyAction",
                    "LoadSubset",
                    "ValidateAction",
                    "PullChanges",
                ]);
            })
        )
    );
});

test("authorization makes an owned server read-only and defects never escape as provider details", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "owned",
                    backend: { ...owned, loadSubset: () => Effect.die(new Error("private-token")) },
                    ir,
                    authorize: (request) =>
                        request.operation === "ApplyAction"
                            ? Effect.fail(
                                  new BackendError({
                                      operation: "authorize",
                                      kind: "Forbidden",
                                      message: "private policy",
                                      retryable: false,
                                      actionOutcome: "not-committed",
                                  })
                              )
                            : Effect.void,
                });
                yield* Effect.gen(function* () {
                    const backend = yield* connectOntologyBackendHttp({ url: "https://ontology.test/rpc" });
                    const denied = yield* Effect.result(
                        backend.applyAction({ id: "denied", name: "increment", parameters: {} })
                    );
                    expect(denied).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Forbidden", actionOutcome: "not-committed" },
                    });
                    expect(JSON.stringify(denied)).not.toContain("private policy");
                    const defect = yield* Effect.result(backend.loadSubset(objectSubset("Counter")));
                    expect(defect).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Internal", actionOutcome: "unknown" },
                    });
                    expect(JSON.stringify(defect)).not.toContain("private-token");
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
                expect((yield* owned.loadSubset(objectSubset("Counter"))).rows).toEqual([]);
            })
        )
    );
});

test("a replica server keeps its committed facet separate from speculative publication", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "composed-server",
                    ir,
                    backend: owned,
                    tables: yield* Memory.make(),
                    live: false,
                    network: { online: Effect.succeed(false), changes: Stream.never },
                    mutators: { increment: (tx) => tx.put("Counter", { id: "one", count: 1 }) },
                });
                yield* replicaController(replica).enqueue({ id: "local", name: "increment", parameters: {} });
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "replica",
                    replica,
                    backend: owned,
                    authorize: () => Effect.void,
                });
                yield* Effect.gen(function* () {
                    const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                    expect(connection.backend.changes).toBeDefined();
                    expect((yield* connection.backend.loadSubset(objectSubset("Counter"))).rows).toEqual([]);
                    const source = speculativeSource(connection);
                    const session = yield* source.openClient();
                    const selected = yield* source.read(session, {
                        generation: 1,
                        selection: { subsets: [{ objectType: "Counter" }], actionIds: [] },
                    });
                    expect(selected.state.objects[0]?.base).toEqual([]);
                    expect(selected.state.objects[0]?.overrides[0]).toMatchObject({
                        key: "one",
                        value: { deleted: false, value: { id: "one", count: 1 } },
                    });
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
                expect(yield* replicaController(replica).pending).toHaveLength(1);
                expect((yield* owned.loadSubset(objectSubset("Counter"))).rows).toEqual([]);
            })
        )
    );
});

test("a failing error-disclosure policy cannot leak its defect over RPC", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "owned",
                    backend: owned,
                    errors: () => {
                        throw new Error("private-policy-detail");
                    },
                    authorize: (request) =>
                        request.operation === "ApplyAction"
                            ? Effect.fail(
                                  new BackendError({
                                      operation: "authorize",
                                      kind: "Forbidden",
                                      message: "secret",
                                      retryable: false,
                                  })
                              )
                            : Effect.void,
                });
                yield* Effect.gen(function* () {
                    const backend = yield* connectOntologyBackendHttp({ url: "https://ontology.test/rpc" });
                    const result = yield* Effect.result(
                        backend.applyAction({ id: "policy-defect", name: "increment", parameters: {} })
                    );
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "Internal", actionOutcome: "unknown" },
                    });
                    expect(JSON.stringify(result)).not.toMatch(/secret|private-policy-detail/);
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
            })
        )
    );
});

test("only replica servers advertise speculative state; owned and proxy roles expose the committed adapter", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "roles",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,
                    live: false,
                });
                const roles: readonly import("./composition.js").OntologyServerOptions[] = [
                    { kind: "owned", backend: owned, authorize: () => Effect.void },
                    { kind: "proxy", backend: owned, authorize: () => Effect.void, ir },
                    {
                        kind: "cached-proxy",
                        backend: owned,
                        cache: replica,
                        authorize: () => Effect.void,
                        ir,
                    },
                    { kind: "replica", backend: owned, replica, authorize: () => Effect.void },
                ];
                for (const options of roles) {
                    const { handleRequest } = yield* makeOntologyServer(options);
                    yield* Effect.gen(function* () {
                        const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                        expect(connection.replication.kind).toBe(
                            options.kind === "replica" ? "speculative" : "committed"
                        );
                        expect(connection.definitionHash).toBe(
                            yield* digestBytes({
                                type: "application/json",
                                stream: Stream.make(
                                    new TextEncoder().encode(ontologyDefinitionSignature(ir))
                                ),
                            })
                        );
                        expect(connection.backend.changes).toBeDefined();
                        expect((yield* connection.backend.loadSubset(objectSubset("Counter"))).complete).toBe(
                            true
                        );
                    }).pipe(
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            handleRequest(new Request(input, init))
                        )
                    );
                }
            })
        ).pipe(Effect.provide(FetchHttpClient.layer))
    );
});

test.each(["absent", "read-only", "read-write"] as const)(
    "HTTP preserves %s attachment capabilities",
    async (mode) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* setup();
                    const { handleRequest } = yield* makeOntologyServer({
                        kind: "proxy",
                        ir,
                        authorize: () => Effect.void,
                        backend: {
                            ...owned,
                            attachments:
                                mode === "absent"
                                    ? undefined
                                    : {
                                          stage:
                                              mode === "read-write"
                                                  ? (value) => Effect.succeed(value)
                                                  : undefined,
                                          read: () => Effect.succeed(new Blob(["test"])),
                                          metadata: () => Effect.succeed({ size: 4 }),
                                      },
                        },
                    });
                    yield* Effect.gen(function* () {
                        const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                        expect(Boolean(connection.backend.attachments)).toBe(mode !== "absent");
                        expect(Boolean(connection.backend.attachments?.stage)).toBe(mode === "read-write");
                        expect(connection.backend.encrypted).toBeUndefined();
                        if (connection.backend.attachments) {
                            const blob = yield* collectByteBlob(
                                yield* connection.backend.attachments.read({ id: "file" })
                            );
                            expect(yield* Effect.promise(() => blob.text())).toBe("test");
                        }
                    }).pipe(
                        Effect.provide(FetchHttpClient.layer),
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            handleRequest(new Request(input, init))
                        )
                    );
                })
            )
        );
    }
);

test("committed RPC subset watching preserves provider hints and releases its scope", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                let watchers = 0;
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            backend: {
                                ...owned,
                                watchSubset: () =>
                                    Stream.unwrap(
                                        Effect.acquireRelease(
                                            Effect.sync(() => {
                                                watchers++;
                                                return Stream.never;
                                            }),
                                            () =>
                                                Effect.sync(() => {
                                                    watchers--;
                                                })
                                        )
                                    ),
                                refresh: () => ({ pollIntervalMs: false }),
                            },
                            ir,
                            authorize: () => Effect.void,
                        })
                    )
                );
                const connection = yield* makeOntologyProtocolClient(client);
                expect(connection.replication.kind).toBe("committed");
                expect(connection.backend.watchSubset).toBeDefined();
                const subscription = yield* Scope.make();
                yield* Scope.provide(
                    Stream.runDrain(connection.backend.watchSubset!(objectSubset("Counter"))!).pipe(
                        Effect.forkScoped
                    ),
                    subscription
                );
                yield* Effect.promise(() => vi.waitFor(() => expect(watchers).toBe(1)));
                yield* Scope.close(subscription, Exit.void);
                expect(watchers).toBe(0);
            })
        )
    );
});

test.each(["watchSubset", "changes"] as const)(
    "RPC %s exposes failed watch attempts to replica supervision",
    async (hook) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* setup();
                    const failure = new BackendError({
                        operation: "test.watch",
                        kind: "RateLimited",
                        retryable: true,
                        retryAfterMs: 30_000,
                        message: "Try later.",
                    });
                    const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                        Effect.provide(
                            ontologyRpcHandlers({
                                backend: {
                                    ...owned,
                                    watchSubset: () => Stream.fail(failure),
                                    changes: { ...owned.changes!, watch: Stream.fail(failure) },
                                },
                                ir,
                                errors: "forward",
                                authorize: () => Effect.void,
                            })
                        )
                    );
                    const connection = yield* makeOntologyProtocolClient(client);
                    const stream =
                        hook === "changes"
                            ? connection.backend.changes!.watch!
                            : connection.backend.watchSubset!(objectSubset("Counter"))!;
                    const result = yield* Effect.result(Stream.runDrain(stream).pipe(Effect.timeout(200)));
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: { kind: "RateLimited", retryable: true, retryAfterMs: 30_000 },
                    });
                })
            )
        );
    }
);

test.each([
    "InvalidRequest",
    "InvalidResponse",
    "InvalidConfiguration",
    "ValidationFailed",
    "HistoryExpired",
] as const)("RPC preserves %s in the typed failure channel", async (kind) => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            backend: {
                                ...owned,
                                loadSubset: () =>
                                    Effect.fail(
                                        new BackendError({
                                            operation: "loadSubset",
                                            kind,
                                            message: "private detail",
                                            retryable: false,
                                        })
                                    ),
                            },
                            authorize: () => Effect.void,
                        })
                    )
                );
                const result = yield* Effect.result(client.LoadSubset(objectSubset("Counter")));
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "BackendError", kind, retryable: false },
                });
                expect(result._tag === "Failure" && result.failure instanceof BackendError).toBe(true);
                expect(JSON.stringify(result)).not.toContain("private detail");
            })
        )
    );
});

test.each(
    (["owned", "cached-proxy", "replica"] as const).flatMap((kind) =>
        (["snapshot", "incremental"] as const).map((deliveryStrategy) => ({ kind, deliveryStrategy }))
    )
)(
    "$kind HTTP $deliveryStrategy delivery preserves external edits and action settlement",
    async ({ kind, deliveryStrategy }) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const owned = yield* setup();
                    yield* owned.applyAction({ id: "seed", name: "increment", parameters: {} });
                    const execute = Effect.fnUntraced(function* (
                        tx: import("@party-stack/ontology-backend/owned").OwnedTransaction
                    ) {
                        const old = yield* tx.get("Counter", "one");
                        yield* tx.put("Counter", { id: "one", count: Number(old?.count ?? 0) + 1 });
                    });
                    const parent = yield* makeReplica({
                        namespace: `http-${kind}`,
                        ir,
                        mutators: { increment: execute },
                        backend: owned,
                        tables: yield* Memory.make(),
                        live: false,
                    });
                    const requests: string[] = [];
                    const common = {
                        ir,
                        deliveryStrategy,
                        authorize: (request: import("./rpc.js").OntologyRpcRequest) =>
                            Effect.sync(() => {
                                requests.push(request.operation);
                            }),
                    };
                    const { handleRequest } = yield* makeOntologyServer(
                        kind === "owned"
                            ? { ...common, kind, backend: owned }
                            : kind === "cached-proxy"
                              ? { ...common, kind, backend: owned, cache: parent }
                              : { ...common, kind, backend: owned, replica: parent }
                    );
                    const wait = (condition: Effect.Effect<boolean, BackendError>) =>
                        Effect.gen(function* () {
                            while (!(yield* condition)) yield* Effect.sleep(2);
                        }).pipe(Effect.timeout("3 seconds"));
                    yield* Effect.gen(function* () {
                        const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                        if (kind === "replica" && deliveryStrategy === "incremental") {
                            // Its ordinary committed facet must use the endpoint's advertised identity too.
                            yield* Effect.scoped(
                                Effect.gen(function* () {
                                    const subscription = yield* connection.backend.subscribeSelection!({
                                        subsets: [objectSubset("Counter")],
                                    });
                                    const pull = yield* Stream.toPull(subscription.frames);
                                    for (;;) {
                                        const frames = yield* pull;
                                        const end = frames.find((frame) => frame.end);
                                        if (end) {
                                            expect(end.metadata?.sourceId).toBe(connection.backend.sourceId);
                                            yield* subscription.acknowledge(end);
                                            break;
                                        }
                                    }
                                })
                            );
                        }
                        const child = yield* makeReplica({
                            namespace: "http-child",
                            ir,
                            mutators: { increment: execute },
                            tables: yield* Memory.make(),
                            ...(connection.replication.kind === "speculative"
                                ? { source: connection.replication.source }
                                : { backend: connection.backend }),
                        });
                        yield* child.demand.acquire({
                            from: { source: { objectType: "Counter" }, binding: "row" },
                        });
                        yield* child.syncOnce;
                        yield* wait(child.get("Counter", "one").pipe(Effect.map((row) => row?.count === 1)));
                        yield* owned.applyAction({ id: "external", name: "increment", parameters: {} });
                        if (kind !== "owned") yield* parent.syncOnce;
                        yield* wait(child.get("Counter", "one").pipe(Effect.map((row) => row?.count === 2)));
                        yield* replicaController(child).enqueue({
                            id: "http-write",
                            name: "increment",
                            parameters: {},
                        });
                        if (kind === "replica") {
                            yield* wait(
                                replicaController(parent).pending.pipe(
                                    Effect.map((entries) =>
                                        entries.some((entry) => entry.invocation.id === "http-write")
                                    )
                                )
                            );
                            yield* parent.syncOnce;
                        }
                        yield* wait(
                            child.outbox
                                .get("http-write")
                                .pipe(Effect.map((status) => status.receipt?.outcome === "committed"))
                        );
                        expect((yield* child.get("Counter", "one"))?.count).toBe(3);
                        if (deliveryStrategy === "incremental") {
                            expect(requests).toContain("AckDelivery");
                            expect(requests).toContain(
                                kind === "replica" ? "SubscribeState" : "SubscribeSelection"
                            );
                            expect(requests).toContain(kind === "replica" ? "Accept" : "ApplyAction");
                            expect(requests).not.toContain("Submit");
                        } else {
                            expect(connection.backend.subscribeSelection).toBeUndefined();
                            expect(connection.backend.changes).toBeUndefined();
                            if (connection.replication.kind === "speculative")
                                expect(connection.replication.source.subscribe).toBeUndefined();
                            expect(requests).toContain(kind === "replica" ? "Read" : "LoadSubset");
                            expect(requests).toContain(kind === "replica" ? "Submit" : "ApplyAction");
                            expect(requests).not.toContain("SubscribeState");
                            expect(requests).not.toContain("SubscribeSelection");
                            expect(requests).not.toContain("AckDelivery");
                            expect(requests).not.toContain("PullChanges");
                        }
                    }).pipe(
                        Effect.provide(FetchHttpClient.layer),
                        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                            handleRequest(new Request(input, init))
                        )
                    );
                })
            )
        );
    }
);

test("snapshot endpoints reject direct incremental calls and retain subset invalidation hints", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup();
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            backend,
                            ir,
                            deliveryStrategy: "snapshot",
                            authorize: () => Effect.void,
                        })
                    )
                );
                expect(yield* client.Describe()).toMatchObject({
                    delivery: false,
                    changes: false,
                    watchSubset: true,
                });
                const subscription = yield* Effect.result(
                    Stream.runDrain(
                        client.SubscribeSelection({
                            selection: {
                                subsets: [objectSubset("Counter")],
                            },
                        })
                    )
                );
                expect(subscription).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotImplemented" },
                });
                const journal = yield* Effect.result(client.PullChanges({}));
                expect(journal).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotImplemented" },
                });
                expect(
                    yield* Stream.runCollect(client.WatchSubset(objectSubset("Counter")).pipe(Stream.take(1)))
                ).toEqual(["invalidate"]);
            })
        )
    );
});

test("explicit incremental configuration rejects a source without native delivery", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* setup();
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            backend: {
                                ...backend,
                                subscribeSelection: undefined,
                                acknowledgeDelivery: undefined,
                            },
                            ir,
                            deliveryStrategy: "incremental",
                            authorize: () => Effect.void,
                        })
                    )
                );
                expect(yield* Effect.result(client.Describe())).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "NotImplemented", retryable: false },
                });
            })
        )
    );
});
