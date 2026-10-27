import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { o, type OntologyIR } from "@party-stack/ontology";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica, replicaStateSource } from "@party-stack/ontology-replica";
import { collectByteBlob, type ByteInput } from "@party-stack/ontology-storage/blobs";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit, Scope } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { connectOntologyWorker, serveOntologyWorker } from "./rpcWorker.js";
import type { OntologySource } from "@party-stack/ontology-backend/protocol";
import type { ReplicaOptions } from "@party-stack/ontology-replica";

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
const increment: ReplicaOptions["execute"] = (tx) =>
    Effect.gen(function* () {
        const row = yield* tx.get("Counter", "one");
        yield* tx.put("Counter", { id: "one", count: Number(row?.count ?? 0) + 1 });
    });
const openPort = Effect.fnUntraced(function* (
    source: OntologySource,
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
                    execute: increment,
                    startSync: false,
                    gc: false,
                });
                yield* owner.syncOnce;
                const tabs = [];
                for (const namespace of ["first", "second"]) {
                    const source = yield* openPort(replicaStateSource(owner));
                    const tab = yield* makeReplica({
                        namespace,
                        ir,
                        tables: yield* Memory.make(),
                        source,
                        execute: increment,
                        gc: false,
                        startSync: false,
                    });
                    yield* tab.retainLocal("Counter");
                    yield* tab.syncOnce;
                    tabs.push(tab);
                }
                const [first, second] = tabs;
                yield* first!.enqueue({ id: "action", name: "increment", parameters: {} });
                expect((yield* first!.get("Counter", "one"))?.count).toBe(2);
                expect((yield* second!.get("Counter", "one"))?.count).toBe(1);
                yield* first!.syncOnce;
                yield* second!.syncOnce;
                expect((yield* owner.pending).map((entry) => entry.invocation.id)).toEqual(["action"]);
                expect((yield* second!.get("Counter", "one"))?.count).toBe(2);
                expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(1);
                yield* owner.syncOnce;
                for (const tab of tabs) {
                    yield* tab.syncOnce;
                    expect((yield* tab.get("Counter", "one"))?.count).toBe(2);
                }
                expect((yield* first!.receipt("action"))?.outcome).toBe("committed");
                expect(yield* owner.pending).toEqual([]);
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
                const source = {
                    ...backend.protocol,
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
                const firstScope = yield* Scope.make();
                const first = yield* Scope.provide(openPort(source), firstScope);
                const second = yield* openPort(source);
                yield* Scope.provide(first.demand({ objectType: "Counter" }), firstScope);
                yield* second.demand({ objectType: "Counter" });
                expect(leases).toBe(2);
                yield* Scope.close(firstScope, Exit.void);
                yield* Effect.promise(() => vi.waitFor(() => expect(leases).toBe(1)));
                const session = yield* second.openClient();
                const result = yield* second.submit({
                    session,
                    sequence: 1,
                    invocation: { id: "survivor", name: "increment", parameters: {} },
                    optimistic: true,
                });
                expect(result.state.objects[0]?.base[0]?.value.count).toBe(1);
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
                    source: owned.protocol,
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
                const connection = yield* openPort(owned.protocol, backend);
                const data = new Uint8Array(170_000).map((_, index) => index % 251);
                const { attachment } = yield* Effect.promise(() =>
                    connection.operations.attachments.create(new Blob([data], { type: "image/png" }), {
                        id: "port-file",
                    })
                );
                const blob = yield* Effect.promise(() => connection.operations.attachments.blob(attachment));
                expect(new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))).toEqual(data);
                expect(
                    yield* Effect.promise(() => connection.operations.attachments.metadata(attachment))
                ).toMatchObject({ size: data.length, type: "image/png" });
            })
        )
    );
});
