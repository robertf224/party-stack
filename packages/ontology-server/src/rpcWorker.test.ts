import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { makeReplica } from "@party-stack/ontology-replica";
import { replicaStateSource } from "@party-stack/ontology-replica/infrastructure";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { collectByteBlob, type ByteInput } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { replicaController } from "../../ontology-replica/lib/internal.js";
import { connectOntologyWorker, serveOntologyWorker, serveOpenedOntologyWorker } from "./rpcWorker.js";
import type { OntologyConnection } from "./rpc.js";
import type { OwnedTransaction } from "@party-stack/ontology-backend/owned";
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
    actionTypes: [{ name: "increment", displayName: "Increment", parameters: [], logic: [] }],
};
const increment = (tx: OwnedTransaction) =>
    Effect.gen(function* () {
        const row = yield* tx.get("Counter", "one");
        yield* tx.put("Counter", { id: "one", count: Number(row?.count ?? 0) + 1 });
    });
const openPort = Effect.fnUntraced(function* (
    source: OntologySource | undefined,
    backend?: import("@party-stack/ontology-backend").OntologyBackendService
) {
    const channel = new MessageChannel();
    yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
            channel.port1.close();
            channel.port2.close();
        })
    );
    yield* serveOntologyWorker({ source, backend, authorize: () => Effect.void }).pipe(
        Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1))
    );
    return yield* connectOntologyWorker().pipe(Effect.provide(BrowserWorker.layer(() => channel.port2)));
});

test("multipart worker delivery carries a rejection after successful actions from two clients", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "rejection-authority",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment },
                });
                yield* owned.storage.transaction((tx) =>
                    Effect.forEach(
                        Array.from({ length: 200 }, (_, n) => n),
                        (n) => tx.put("Counter", { id: `cached-${n}`, count: n }),
                        { discard: true }
                    )
                );
                const rejectNow = yield* Deferred.make<void>();
                const backend = {
                    ...owned,
                    applyAction: (request: Parameters<typeof owned.applyAction>[0]) =>
                        request.id === "rejected"
                            ? Deferred.await(rejectNow).pipe(
                                  Effect.andThen(
                                      Effect.fail(
                                          new BackendError({
                                              operation: "applyAction",
                                              kind: "ValidationFailed",
                                              message: "Rejected input.",
                                              retryable: false,
                                              actionOutcome: "not-committed",
                                          })
                                      )
                                  )
                              )
                            : owned.applyAction(request),
                };
                const parent = yield* makeReplica({
                    namespace: "rejection-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    mutators: { increment },
                    outbox: { failureStrategy: "discard-all" },
                });
                const source = replicaStateSource(parent);
                const connect = Effect.fnUntraced(function* (namespace: string) {
                    const connection = yield* openPort(source, backend);
                    return yield* makeReplica({
                        namespace,
                        ir,
                        tables: yield* Memory.make(),
                        source: speculativeSource(connection),
                        mutators: { increment },
                    });
                });
                const first = yield* connect("first");
                const second = yield* connect("second");
                const subset = { from: { source: { objectType: "Counter" }, binding: "counter" } };
                yield* first.demand.acquire(subset);
                yield* second.demand.acquire(subset);
                yield* Stream.runDrain(second.outbox.observe()).pipe(
                    Effect.forkScoped({ startImmediately: true })
                );
                for (const [child, id] of [
                    [first, "first-success"],
                    [second, "second-success"],
                ] as const) {
                    yield* child.outbox.enqueue({ id, name: "increment", parameters: {} });
                    yield* child.outbox.wait(id).pipe(Effect.timeout("3 seconds"));
                }
                yield* first.outbox.enqueue({ id: "rejected", name: "increment", parameters: {} });
                const waiter = yield* Effect.forkScoped(
                    Effect.result(first.outbox.wait("rejected").pipe(Effect.timeout("3 seconds")))
                );
                yield* first.outbox.wait("rejected", { until: "accepted" }).pipe(Effect.timeout("3 seconds"));
                yield* Deferred.succeed(rejectNow, undefined);
                const result = yield* Fiber.join(waiter);
                expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "ValidationFailed" } });
                expect(yield* first.outbox.entries).toEqual([]);
            })
        )
    );
}, 20_000);

test("worker composition serves during delayed acquisition and releases its opened facade on interruption", async () => {
    const cleanup = vi.fn(async () => {});
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const channel = new MessageChannel();
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        channel.port1.close();
                        channel.port2.close();
                    })
                );
                const backend = yield* makeOwnedBackend({
                    namespace: "composed-worker-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment },
                });
                yield* backend.applyAction({ id: "seed", name: "increment", parameters: {} });
                const owner = yield* makeReplica({
                    namespace: "composed-worker-owner",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    mutators: { increment },
                    live: false,
                    cache: { objects: false },
                });
                yield* owner.demand.acquire({ from: { source: { objectType: "Counter" }, binding: "row" } });
                yield* owner.syncOnce;
                const gate = yield* Deferred.make<void>();
                const started = yield* Deferred.make<void>();
                const host = yield* serveOpenedOntologyWorker({
                    open: Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(gate);
                        yield* Effect.addFinalizer(() => Effect.promise(cleanup));
                        return { replica: owner, backend };
                    }),
                    errors: "forward",
                    authorize: () => Effect.void,
                }).pipe(
                    Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1)),
                    Effect.forkScoped
                );
                yield* Deferred.await(started);
                const connecting = yield* connectOntologyWorker().pipe(
                    Effect.provide(BrowserWorker.layer(() => channel.port2)),
                    Effect.forkScoped
                );
                expect(cleanup).not.toHaveBeenCalled();
                yield* Deferred.succeed(gate, undefined);
                const source = yield* Fiber.join(connecting);
                const session = yield* speculativeSource(source).openClient();
                const batch = yield* speculativeSource(source).read(session, {
                    generation: 1,
                    selection: { subsets: [{ objectType: "Counter" }], actionIds: [] },
                });
                expect(batch.state.objects[0]?.base[0]?.value.count).toBe(1);
                expect(cleanup).not.toHaveBeenCalled();
                yield* Fiber.interrupt(host);
                expect(cleanup).toHaveBeenCalledTimes(1);
            })
        )
    );
});

test.each(["failure", "defect"] as const)(
    "worker startup reports a %s and releases partially acquired resources",
    async (kind) => {
        const cleanup = vi.fn();
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const channel = new MessageChannel();
                    yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                            channel.port1.close();
                            channel.port2.close();
                        })
                    );
                    yield* serveOpenedOntologyWorker({
                        open: Effect.gen(function* () {
                            yield* Effect.addFinalizer(() => Effect.sync(cleanup));
                            if (kind === "defect")
                                return yield* Effect.die(new Error("private startup detail"));
                            return yield* new BackendError({
                                operation: "test.open",
                                kind: "Unauthenticated",
                                retryable: false,
                                message: "Sign in again.",
                            });
                        }),
                        errors: "forward",
                        authorize: () => Effect.void,
                    }).pipe(
                        Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1)),
                        Effect.forkScoped
                    );
                    const result = yield* Effect.result(
                        connectOntologyWorker().pipe(Effect.provide(BrowserWorker.layer(() => channel.port2)))
                    );
                    expect(result).toMatchObject({
                        _tag: "Failure",
                        failure: {
                            kind: kind === "defect" ? "Internal" : "Unauthenticated",
                            retryable: false,
                        },
                    });
                    if (result._tag === "Failure")
                        expect(result.failure.message).not.toContain("private startup detail");
                    expect(cleanup).toHaveBeenCalledTimes(1);
                })
            )
        );
    }
);

test("two memory tabs hand off actions to one owner through native MessagePorts", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "worker-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment },
                });
                yield* backend.applyAction({ id: "seed", name: "increment", parameters: {} });
                const owner = yield* makeReplica({
                    namespace: "worker-owner",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    mutators: { increment },
                    live: false,
                    cache: { objects: false },
                });
                yield* owner.syncOnce;
                const tabs = [];
                for (const namespace of ["first", "second"]) {
                    const source = yield* openPort(replicaStateSource(owner));
                    const tab = yield* makeReplica({
                        namespace,
                        ir,
                        tables: yield* Memory.make(),
                        source: speculativeSource(source),
                        mutators: { increment },
                        cache: { objects: false },
                        live: false,
                    });
                    yield* replicaController(tab).retainLocal("Counter");
                    yield* tab.syncOnce;
                    tabs.push(tab);
                }
                const [first, second] = tabs;
                yield* replicaController(first!).enqueue({ id: "action", name: "increment", parameters: {} });
                expect((yield* first!.get("Counter", "one"))?.count).toBe(2);
                expect((yield* second!.get("Counter", "one"))?.count).toBe(1);
                yield* first!.syncOnce;
                yield* second!.syncOnce;
                expect((yield* replicaController(owner).pending).map((entry) => entry.invocation.id)).toEqual(
                    ["action"]
                );
                expect((yield* second!.get("Counter", "one"))?.count).toBe(2);
                expect((yield* backend.loadSubset(objectSubset("Counter"))).rows[0]?.value.count).toBe(1);
                yield* owner.syncOnce;
                for (const tab of tabs) {
                    yield* tab.syncOnce;
                    expect((yield* tab.get("Counter", "one"))?.count).toBe(2);
                }
                expect((yield* replicaController(first!).receipt("action"))?.outcome).toBe("committed");
                expect(yield* replicaController(owner).pending).toEqual([]);
            })
        )
    );
});

test("closing one port releases its demands without closing the shared source", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "worker-leases",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { increment },
                });
                let leases = 0;
                const parent = yield* makeReplica({
                    namespace: "lease-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend,
                    mutators: { increment },
                });
                const source = {
                    ...replicaStateSource(parent),
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
                const firstScope = yield* Scope.make();
                const first = yield* Scope.provide(openPort(source), firstScope);
                const second = yield* openPort(source);
                yield* Scope.provide(
                    holdDemand(speculativeSource(first).demand({ objectType: "Counter" })),
                    firstScope
                );
                yield* holdDemand(speculativeSource(second).demand({ objectType: "Counter" }));
                expect(leases).toBe(2);
                yield* Scope.close(firstScope, Exit.void);
                yield* Effect.promise(() => vi.waitFor(() => expect(leases).toBe(1)));
                const session = yield* speculativeSource(second).openClient();
                yield* speculativeSource(second).submit({
                    session,
                    sequence: 1,
                    invocation: { id: "survivor", name: "increment", parameters: {} },
                    optimistic: true,
                });
                yield* parent.outbox.wait("survivor");
                expect((yield* source.read(session)).state.objects[0]?.base[0]?.value.count).toBe(1);
            })
        )
    );
});

test("worker startup times out and releases its transport before choosing a fallback", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const channel = new MessageChannel();
                let closed = false;
                channel.port1.addEventListener("message", (event) => {
                    if (event.data[0] === 1) closed = true;
                });
                channel.port1.start();
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        channel.port1.close();
                        channel.port2.close();
                    })
                );
                const result = yield* Effect.result(
                    connectOntologyWorker({ connectionTimeoutMs: 10 }).pipe(
                        Effect.provide(BrowserWorker.layer(() => channel.port2))
                    )
                );
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: {
                        kind: "Unavailable",
                        retryable: true,
                        message: "Ontology worker handshake timed out.",
                    },
                });
                yield* Effect.promise(() => vi.waitFor(() => expect(closed).toBe(true)));
            })
        )
    );
});

test("bootstrap failures reach the worker handshake as typed errors", async () => {
    const { BackendError } = await import("@party-stack/ontology-backend");
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "bootstrap-failure",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const channel = new MessageChannel();
                yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                        channel.port1.close();
                        channel.port2.close();
                    })
                );
                yield* serveOntologyWorker({
                    backend: owned,
                    ir,
                    authorize: () => Effect.void,
                    errors: "forward",
                    ready: Effect.fail(
                        new BackendError({
                            operation: "owner.open",
                            kind: "ValidationFailed",
                            retryable: false,
                            message: "Principal partition is unavailable.",
                        })
                    ),
                }).pipe(Effect.provide(BrowserWorkerRunner.layerMessagePort(channel.port1)));
                const result = yield* Effect.result(
                    connectOntologyWorker().pipe(Effect.provide(BrowserWorker.layer(() => channel.port2)))
                );
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed", message: "Principal partition is unavailable." },
                });
            })
        )
    );
});

test("streams attachment transfers over MessagePorts into a source-only backend", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* makeOwnedBackend({
                    namespace: "bytes-port",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: {},
                });
                const bytes = new Map<string, Blob>();
                const backend = {
                    ...owned,
                    attachments: {
                        stage: (attachment: { id: string }, input: ByteInput) =>
                            collectByteBlob(input).pipe(
                                Effect.map((blob) => {
                                    bytes.set(attachment.id, blob);
                                    return attachment;
                                }),
                                Effect.mapError(
                                    (cause) =>
                                        new BackendError({
                                            operation: "stage",
                                            kind: "Unavailable",
                                            message: "Upload failed.",
                                            retryable: false,
                                            cause,
                                        })
                                )
                            ),
                        read: (attachment: { id: string }) => Effect.succeed(bytes.get(attachment.id)!),
                        metadata: (attachment: { id: string }) =>
                            Effect.succeed({
                                size: bytes.get(attachment.id)!.size,
                                type: bytes.get(attachment.id)!.type,
                                name: attachment.id,
                            }),
                    },
                };
                const connection = yield* openPort(undefined, backend);
                const data = new Uint8Array(170_000).map((_, index) => index % 251);
                const { attachment } = yield* connection.operations.attachments.create(
                    new Blob([data], { type: "image/png" }),
                    {
                        id: "port-file",
                    }
                );
                const blob = yield* connection.operations.attachments.blob(attachment);
                expect(new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))).toEqual(data);
                expect(yield* connection.operations.attachments.metadata(attachment)).toMatchObject({
                    size: data.length,
                    type: "image/png",
                });
            })
        )
    );
});
