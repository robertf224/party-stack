import { o, type OntologyIR } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica } from "@party-stack/ontology-replica";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcTest } from "effect/rpc";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeOntologyServer } from "./composition.js";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import { connectOntologyBackendHttp, connectOntologyHttp, makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

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

test("domain RPC carries selected state, resumable ordered actions and acknowledgments", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const operations: string[] = [];
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            source: owned.protocol,
                            authorize: (request) =>
                                Effect.sync(() => {
                                    operations.push(request.operation);
                                }),
                        })
                    )
                );
                const source = yield* makeOntologyProtocolClient(client);
                const session = yield* source.openClient();
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
                const delivered = yield* source.submit(request);
                expect((yield* source.submit(request)).state).toEqual(delivered.state);
                expect(delivered.state.objects[0]?.base[0]?.value.count).toBe(1);
                expect(delivered.state.completed[0]?.receipt?.outcome).toBe("committed");
                yield* source.acknowledge(
                    session,
                    delivered.state.revision,
                    delivered.client.deliveredThrough,
                    view.generation
                );
                expect((yield* source.read(session, view)).state.completed).toEqual([]);
                expect((yield* Effect.result(source.submit(request)))._tag).toBe("Failure");
                const resumed = yield* source.openClient(session.client);
                expect(resumed.acceptedThrough).toBe(1);
                expect(resumed.connectionId).not.toBe(session.connectionId);
                expect((yield* Effect.result(source.read(session, view)))._tag).toBe("Failure");
                expect(operations).toContain("Read");
                expect(operations).toContain("Acknowledge");
            })
        )
    );
});

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
                let leases = 0;
                const source: OntologySource = {
                    ...owned.protocol,
                    demand: () =>
                        Effect.acquireRelease(
                            Effect.sync(() => {
                                leases++;
                            }),
                            () =>
                                Effect.sync(() => {
                                    leases--;
                                })
                        ),
                };
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(ontologyRpcHandlers({ source, authorize: () => Effect.void }))
                );
                const remote = yield* makeOntologyProtocolClient(client);
                const session = yield* remote.openClient();
                const consumer = yield* Scope.make();
                yield* Scope.provide(remote.demand({ objectType: "Counter" }), consumer);
                expect(leases).toBe(1);
                const initial = yield* Deferred.make<void>();
                let messages = 0;
                yield* Scope.provide(
                    Effect.gen(function* () {
                        const changes = yield* remote.subscribeChanges;
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
                expect((yield* remote.read(session)).state.objects[0]?.base[0]?.value.count).toBe(1);
            })
        )
    );
});

test("HTTP RPC preserves values/authentication and reacquires interrupted streaming leases", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
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
                        ...owned.protocol,
                        read: (session, view) =>
                            owned.protocol.read(session, view).pipe(
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
                            Effect.acquireRelease(
                                Effect.sync(() => {
                                    leases++;
                                    acquisitions++;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        leases--;
                                    })
                            ),
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
                        retryIntervalMs: 5,
                    }).pipe(
                        Effect.provideService(
                            HttpClient.HttpClient,
                            HttpClient.mapRequest(
                                http,
                                HttpClientRequest.setHeader("authorization", "Bearer test")
                            )
                        )
                    );
                    const session = yield* remote.openClient();
                    yield* remote.submit({
                        session,
                        sequence: 1,
                        invocation: { id: "one", name: "increment", parameters: {} },
                        optimistic: true,
                    });
                    const state = yield* remote.read(session);
                    expect(state.state.objects[0]?.base[0]?.value.special).toEqual(special);
                    const consumer = yield* Scope.make();
                    yield* Scope.provide(remote.demand({ objectType: "Counter" }), consumer);
                    yield* Effect.promise(() =>
                        vi.waitFor(() => {
                            expect(acquisitions).toBe(2);
                            expect(leases).toBe(1);
                        })
                    );
                    expect(yield* Stream.runHead(yield* remote.subscribeChanges)).toMatchObject({
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
                const read = vi.fn(owned.protocol.read);
                const submit = vi.fn(owned.protocol.submit);
                const demand = vi.fn(owned.protocol.demand);
                const client = yield* RpcTest.makeClient(OntologyRpcs).pipe(
                    Effect.provide(
                        ontologyRpcHandlers({
                            source: { ...owned.protocol, read, submit, demand },
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
                const session = yield* remote.openClient();
                expect(yield* Effect.result(remote.read(session))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed" },
                });
                expect(
                    yield* Effect.result(
                        remote.submit({
                            session,
                            sequence: 1,
                            invocation: { id: "one", name: "increment", parameters: {} },
                            optimistic: true,
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "ValidationFailed" } });
                expect(yield* Effect.result(remote.demand({ objectType: "Counter" }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed" },
                });
                expect(yield* Effect.result(Stream.runDrain(yield* remote.subscribeChanges))).toMatchObject({
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
    const { createRuntimeTraces } = await import("@party-stack/runtime");
    const { Tracer } = await import("effect");
    const traces = createRuntimeTraces();
    const bytes = new Map<string, Blob>();
    const draft = vi.fn(async () => ({ certain: false as const }));
    const operations: string[] = [];
    // Focus this fixture on the real HTTP helper boundary; replica transfer has its own conformance tests.
    const ontology = {
        queryFunctions: { echo: async (parameters: Record<string, unknown>) => parameters },
        actions: {
            action: {
                validate: async () => ({
                    certain: true as const,
                    value: { kind: "ok" as const, value: undefined },
                }),
                validateDraft: draft,
            },
        },
        attachments: {
            create: async (blob: Blob, opts?: { id?: string }) => {
                const id = opts?.id ?? "blob";
                bytes.set(id, blob);
                return { attachment: { id, type: blob.type } };
            },
            blob: async (attachment: { id: string }) => bytes.get(attachment.id)!,
            metadata: async (attachment: { id: string }) => ({
                ...attachment,
                size: bytes.get(attachment.id)!.size,
                type: bytes.get(attachment.id)!.type,
            }),
        },
        traces,
    } as unknown as import("@party-stack/ontology").LiveOntology;
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                ontology.storage = yield* makeReplica({
                    namespace: "inspect-owner",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,
                    execute: () => Effect.void,
                    startSync: false,
                    gc: false,
                });
                const handler = yield* makeOntologyHttpHandler({
                    source: owned.protocol,
                    ontology,
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
                const { attachment } = yield* Effect.promise(() =>
                    client.operations.attachments.create(
                        new Blob([new Uint8Array([0, 255, 127])], { type: "application/octet-stream" })
                    )
                );
                const received = yield* Effect.promise(() => client.operations.attachments.blob(attachment));
                expect(new Uint8Array(yield* Effect.promise(() => received.arrayBuffer()))).toEqual(
                    new Uint8Array([0, 255, 127])
                );
                expect(
                    yield* Effect.promise(() => client.operations.attachments.metadata(attachment))
                ).toMatchObject({ size: 3, type: "application/octet-stream" });
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
                const big = yield* Effect.promise(() =>
                    client.operations.attachments.create(large, { id: "large" })
                );
                expect(materialize).not.toHaveBeenCalled();
                const downloaded = yield* Effect.promise(() =>
                    client.operations.attachments.blob(big.attachment)
                );
                expect(new Uint8Array(yield* Effect.promise(() => downloaded.arrayBuffer()))).toEqual(data);
                const empty = yield* Effect.promise(() =>
                    client.operations.attachments.create(new Blob([]), { id: "empty" })
                );
                expect(
                    (yield* Effect.promise(() => client.operations.attachments.blob(empty.attachment))).size
                ).toBe(0);
                expect(operations).not.toContain("ReplicaStatus");
                const stopMonitoring = client.operations.replicaMonitor.subscribe(() => undefined);
                yield* Effect.addFinalizer(() => Effect.sync(stopMonitoring));
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(client.operations.replicaMonitor.getSnapshot().status).toMatchObject({
                            sourceId: ontology.storage!.sourceId,
                            mode: "adapter",
                            demands: [],
                            loadCount: 0,
                        })
                    )
                );
                // Inspecting the owner does not acquire demand or call the backend.
                expect((yield* ontology.storage.status).loadCount).toBe(0);
                const unsubscribe = client.operations.traces.subscribe(() => undefined);
                yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
                yield* Effect.gen(function* () {
                    const span = yield* Effect.currentSpan;
                    span.event("replica.invalidation", 1_000_000n, { count: 3, token: "secret" });
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
                        "ClearTraces",
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
                    const snapshot = yield* backend.loadSubset({ objectType: "Counter" });
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
                    const defect = yield* Effect.result(backend.loadSubset({ objectType: "Counter" }));
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
                expect((yield* owned.loadSubset({ objectType: "Counter" })).rows).toEqual([]);
            })
        )
    );
});

test("a replica server exposes composed rows without advertising its upstream journal", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "composed-server",
                    ir,
                    backend: owned,
                    tables: yield* Memory.make(),
                    startSync: false,
                    online: Effect.succeed(false),
                    execute: (tx) => tx.put("Counter", { id: "one", count: 1 }),
                });
                yield* replica.enqueue({ id: "local", name: "increment", parameters: {} });
                const { handleRequest } = yield* makeOntologyServer({
                    kind: "replica",
                    replica,
                    backend: owned,
                    authorize: () => Effect.void,
                });
                yield* Effect.gen(function* () {
                    const backend = yield* connectOntologyBackendHttp({ url: "https://ontology.test/rpc" });
                    expect(backend.changes).toBeUndefined();
                    expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(
                        1
                    );
                }).pipe(
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
                        handleRequest(new Request(input, init))
                    )
                );
                expect(yield* replica.pending).toHaveLength(1);
                expect((yield* owned.loadSubset({ objectType: "Counter" })).rows).toEqual([]);
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
