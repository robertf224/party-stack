import { o, type OntologyIR } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica } from "@party-stack/ontology-replica";
import { eq, field } from "@party-stack/ontology-storage";
import { collectByteBlob, digestBytes, type ByteInput } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Scope, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcTest } from "effect/rpc";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeOntologyServer } from "./composition.js";
import { makeOntologyProtocolClient, ontologyRpcHandlers, OntologyRpcs } from "./rpc.js";
import { connectOntologyBackendHttp, connectOntologyHttp, makeOntologyHttpHandler } from "./rpcHttp.js";
import type { OntologyConnection } from "./rpc.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";

const speculativeSource = (connection: OntologyConnection) => {
    if (connection.replication.kind !== "speculative") throw new Error("Expected speculative replication.");
    return connection.replication.source;
};
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
                const delivered = yield* speculativeSource(source).submit(request);
                expect((yield* speculativeSource(source).submit(request)).state).toEqual(delivered.state);
                expect(delivered.state.objects[0]?.base[0]?.value.count).toBe(1);
                expect(delivered.state.completed[0]?.receipt?.outcome).toBe("committed");
                yield* speculativeSource(source).acknowledge(
                    session,
                    delivered.state.revision,
                    delivered.client.deliveredThrough,
                    view.generation
                );
                expect((yield* speculativeSource(source).read(session, view)).state.completed).toEqual([]);
                expect((yield* Effect.result(speculativeSource(source).submit(request)))._tag).toBe(
                    "Failure"
                );
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
                const session = yield* speculativeSource(remote).openClient();
                const consumer = yield* Scope.make();
                yield* Scope.provide(speculativeSource(remote).demand({ objectType: "Counter" }), consumer);
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
                    const session = yield* speculativeSource(remote).openClient();
                    yield* speculativeSource(remote).submit({
                        session,
                        sequence: 1,
                        invocation: { id: "one", name: "increment", parameters: {} },
                        optimistic: true,
                    });
                    const state = yield* speculativeSource(remote).read(session);
                    expect(state.state.objects[0]?.base[0]?.value.special).toEqual(special);
                    const consumer = yield* Scope.make();
                    yield* Scope.provide(
                        speculativeSource(remote).demand({ objectType: "Counter" }),
                        consumer
                    );
                    yield* Effect.promise(() =>
                        vi.waitFor(() => {
                            expect(acquisitions).toBe(2);
                            expect(leases).toBe(1);
                        })
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
                    yield* Effect.result(speculativeSource(remote).demand({ objectType: "Counter" }))
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
            create: async (input: ByteInput, opts?: { id?: string }) => {
                const blob = await Effect.runPromise(collectByteBlob(input));
                const id = opts?.id ?? "blob";
                bytes.set(id, blob);
                return { attachment: { id, type: blob.type } };
            },
            blob: async (attachment: { id: string }) => bytes.get(attachment.id)!,
            source: async (attachment: { id: string }) => bytes.get(attachment.id)!,
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
                    const connection = yield* connectOntologyHttp({ url: "https://ontology.test/rpc" });
                    expect(connection.backend.changes).toBeDefined();
                    expect((yield* connection.backend.loadSubset({ objectType: "Counter" })).rows).toEqual(
                        []
                    );
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
                    startSync: false,
                    execute: () => Effect.void,
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
                                stream: Stream.make(new TextEncoder().encode(JSON.stringify(ir))),
                            })
                        );
                        expect(connection.backend.changes).toBeDefined();
                        expect(
                            (yield* connection.backend.loadSubset({ objectType: "Counter" })).complete
                        ).toBe(true);
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
                                pollIntervalMs: () => false,
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
                    Stream.runDrain(connection.backend.watchSubset!({ objectType: "Counter" })!).pipe(
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
                const result = yield* Effect.result(client.LoadSubset({ objectType: "Counter" }));
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
                        execute,
                        backend: owned,
                        tables: yield* Memory.make(),
                        startSync: false,
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
                                        subsets: [{ objectType: "Counter" }],
                                        actionIds: [],
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
                            execute,
                            tables: yield* Memory.make(),
                            ...(connection.replication.kind === "speculative"
                                ? { source: connection.replication.source }
                                : { backend: connection.backend }),
                        });
                        yield* child.demand({ objectType: "Counter" });
                        yield* child.syncOnce;
                        yield* wait(child.get("Counter", "one").pipe(Effect.map((row) => row?.count === 1)));
                        yield* owned.applyAction({ id: "external", name: "increment", parameters: {} });
                        if (kind !== "owned") yield* parent.syncOnce;
                        yield* wait(child.get("Counter", "one").pipe(Effect.map((row) => row?.count === 2)));
                        yield* child.enqueue({ id: "http-write", name: "increment", parameters: {} });
                        if (kind === "replica") {
                            yield* wait(
                                parent.pending.pipe(
                                    Effect.map((entries) =>
                                        entries.some((entry) => entry.invocation.id === "http-write")
                                    )
                                )
                            );
                            yield* parent.syncOnce;
                        }
                        yield* wait(
                            child
                                .actionStatus("http-write")
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
                            subsets: [{ objectType: "Counter" }],
                            actionIds: [],
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
                    yield* Stream.runCollect(
                        client.WatchSubset({ objectType: "Counter" }).pipe(Stream.take(1))
                    )
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
