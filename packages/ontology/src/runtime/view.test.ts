import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { makeReplica, replicaStateSource } from "@party-stack/ontology-replica";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Runtime } from "@party-stack/runtime";
import { memoryRuntimeFixture } from "@party-stack/runtime/testing";
import { Effect, Exit, Scope, Fiber, Deferred } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { makeReplicaOntologyView } from "./view.js";
import type { LiveOntology } from "../live/LiveOntology.js";
import type { ReplicaOptions } from "@party-stack/ontology-replica";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Note",
            displayName: "Note",
            pluralDisplayName: "Notes",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "title", displayName: "Title", type: o.string({}) },
            ],
        },
    ],
    actionTypes: [{ name: "rename", displayName: "Rename", parameters: [], logic: [] }],
};
const rename: ReplicaOptions["execute"] = (tx, invocation) =>
    tx.put("Note", { id: "one", title: invocation.parameters.title });

test.each(["pause", "discard-all"] as const)(
    "parent rejections preserve field issues with %s recovery",
    async (failureStrategy) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const adapter = memoryRuntimeFixture("test", "rejected-view");
                    yield* Effect.addFinalizer(() =>
                        Effect.promise(async () => {
                            await adapter.cleanup?.();
                        })
                    );
                    const runtime = yield* Runtime.make(adapter);
                    const owned = yield* makeOwnedBackend({
                        namespace: "rejected-server",
                        ir,
                        tables: yield* Memory.make(),
                        mutators: { rename },
                    });
                    let invocations = 0;
                    const owner = yield* makeReplica({
                        namespace: "rejected-owner",
                        ir,
                        tables: yield* Memory.make(),
                        backend: {
                            ...owned,
                            invoke: (invocation) =>
                                Effect.suspend(() => {
                                    invocations++;
                                    return invocation.parameters.title === "invalid"
                                        ? Effect.fail(
                                              new BackendError({
                                                  operation: "invoke",
                                                  kind: "ValidationFailed",
                                                  message: "Invalid title.",
                                                  retryable: false,
                                                  invocationOutcome: "not-committed",
                                                  issues: [
                                                      {
                                                          path: ["title"],
                                                          code: "TooShort",
                                                          category: "input",
                                                          source: "parameter",
                                                          messageSource: "standard",
                                                          message: "Choose a longer title.",
                                                      },
                                                  ],
                                              })
                                          )
                                        : owned.invoke(invocation);
                                }),
                        },
                        execute: rename,
                        startSync: false,
                        gc: false,
                        outbox: { failureStrategy },
                    });
                    const child = yield* makeReplica({
                        namespace: "rejected-child",
                        ir,
                        tables: runtime.tables,
                        source: replicaStateSource(owner),
                        execute: rename,
                        startSync: false,
                        gc: false,
                    });
                    const view = yield* makeReplicaOntologyView({
                        ir,
                        context: {},
                        replica: child,
                        parentOutbox: owner,
                        queryFunction: () => Effect.void,
                        attachments: {} as LiveOntology["attachments"],
                    }).pipe(Effect.provideService(Runtime, runtime));
                    yield* child.retainActions();
                    const enqueue = (id: string) =>
                        Effect.promise(() =>
                            view.outbox.enqueue({
                                idempotencyKey: id,
                                actionTypeName: "rename",
                                parameters: { title: "invalid" },
                            })
                        );
                    const first = yield* enqueue("correct");
                    yield* child.syncOnce;
                    yield* Effect.result(owner.syncOnce);
                    yield* child.syncOnce;
                    yield* Effect.promise(async () => {
                        await expect(first.completed).rejects.toMatchObject({
                            kind: "ValidationFailed",
                            invocationOutcome: "not-committed",
                            issues: [{ path: ["title"], code: "TooShort" }],
                        });
                        await view.outbox.collection._sync.loadSubset({});
                    });
                    if (failureStrategy === "discard-all") {
                        expect(view.outbox.collection.get("correct")).toBeUndefined();
                        expect(yield* owner.pendingActions).toEqual([]);
                        expect(yield* child.pendingActions).toEqual([]);
                        const lateWait = yield* Effect.result(child.awaitAction("correct"));
                        expect(lateWait).toMatchObject({
                            _tag: "Failure",
                            failure: { kind: "ValidationFailed", issues: [{ path: ["title"] }] },
                        });
                        return;
                    }
                    expect(view.outbox.collection.get("correct")).toMatchObject({
                        status: "blocked",
                        attempts: 1,
                        lastError: {
                            kind: "ValidationFailed",
                            issues: [{ path: ["title"], code: "TooShort" }],
                        },
                    });
                    yield* Effect.promise(() =>
                        view.outbox.edit("correct", (request) => {
                            request.parameters.title = "corrected";
                        })
                    );
                    expect((yield* child.pendingActions)[0]?.invocation.parameters.title).toBe("corrected");
                    yield* Effect.result(owner.syncOnce);
                    yield* child.syncOnce;
                    yield* Effect.promise(() => view.outbox.wait("correct"));
                    expect(invocations).toBe(2);
                    expect((yield* owned.storage.read((tx) => tx.get("Note", "one")))?.title).toBe(
                        "corrected"
                    );
                    yield* enqueue("remove");
                    yield* child.syncOnce;
                    yield* Effect.result(owner.syncOnce);
                    yield* child.syncOnce;
                    yield* Effect.promise(() => view.outbox.remove("remove"));
                    yield* child.syncOnce;
                    yield* child.syncOnce;
                    expect(yield* owner.pendingActions).toEqual([]);
                    expect(yield* child.pendingActions).toEqual([]);
                    expect(yield* child.receipt("remove")).toBeUndefined();
                    expect(invocations).toBe(3);
                })
            )
        );
    }
);

test("memory views await durable owner acceptance, inspect shared actions and survive an initiating tab closing", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const backend = yield* makeOwnedBackend({
                    namespace: "view-server",
                    ir,
                    tables: yield* Memory.make(),
                    mutators: { rename },
                });
                const forwarding = yield* Deferred.make<void>();
                const allowForward = yield* Deferred.make<void>();
                const executing = yield* Deferred.make<void>();
                const allowExecute = yield* Deferred.make<void>();
                const owner = yield* makeReplica({
                    namespace: "view-owner",
                    ir,
                    tables: yield* Memory.make(),
                    backend: {
                        ...backend,
                        invoke: (invocation) =>
                            Deferred.succeed(executing, undefined).pipe(
                                Effect.andThen(Deferred.await(allowExecute)),
                                Effect.andThen(backend.invoke(invocation))
                            ),
                    },
                    execute: rename,
                    startSync: false,
                    gc: false,
                });
                const parent = replicaStateSource(owner);
                const source = {
                    ...parent,
                    submit: (request: Parameters<typeof parent.submit>[0]) =>
                        Deferred.succeed(forwarding, undefined).pipe(
                            Effect.andThen(Deferred.await(allowForward)),
                            Effect.andThen(parent.submit(request))
                        ),
                };
                const open = Effect.fnUntraced(function* (name: string) {
                    const scope = yield* Scope.fork(yield* Effect.scope);
                    const tab = yield* Scope.provide(
                        Effect.gen(function* () {
                            const adapter = memoryRuntimeFixture("test", name);
                            yield* Effect.addFinalizer(() =>
                                Effect.promise(async () => {
                                    await adapter.cleanup?.();
                                })
                            );
                            const runtime = yield* Runtime.make(adapter);
                            const replica = yield* makeReplica({
                                namespace: name,
                                ir,
                                tables: runtime.tables,
                                source,
                                execute: rename,
                                startSync: false,
                                gc: false,
                            });
                            const view = yield* makeReplicaOntologyView({
                                ir,
                                context: {},
                                replica,
                                writes: { defaultMode: "outbox", defaultVisibility: "optimistic" },
                                awaitParentAcceptance: true,
                                queryFunction: () => Effect.void,
                                attachments: {} as LiveOntology["attachments"],
                            }).pipe(Effect.provideService(Runtime, runtime));
                            return { replica, view };
                        }),
                        scope
                    );
                    return { ...tab, scope };
                });
                const first = yield* open("first");
                const second = yield* open("second");
                yield* second.replica.retainActions();
                yield* second.replica.retainLocal("Note");
                let accepted = false;
                const submitting = yield* Effect.forkChild(
                    Effect.promise(() =>
                        first.view.outbox
                            .enqueue({
                                idempotencyKey: "rename",
                                actionTypeName: "rename",
                                parameters: { title: "Pending" },
                            })
                            .then((result) => {
                                accepted = true;
                                return result;
                            })
                    )
                );
                yield* Effect.promise(() =>
                    vi.waitFor(async () =>
                        expect((await Effect.runPromise(first.replica.pending)).length).toBe(1)
                    )
                );
                expect(accepted).toBe(false);
                yield* Effect.promise(async () => {
                    await first.view.outbox.collection._sync.loadSubset({});
                });
                const forwardingFiber = yield* Effect.forkChild(first.replica.syncOnce);
                yield* Deferred.await(forwarding);
                expect((yield* first.replica.pendingActions)[0]).toMatchObject({
                    state: "sending",
                    forwarding: true,
                });
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(first.view.outbox.collection.get("rename")).toMatchObject({
                            status: "sending",
                            attemptStage: "forwarding",
                        })
                    )
                );
                yield* Deferred.succeed(allowForward, undefined);
                yield* Fiber.join(forwardingFiber);
                const queued = yield* Fiber.join(submitting);
                expect(accepted).toBe(true);
                expect((yield* owner.pending).map((entry) => entry.invocation.id)).toEqual(["rename"]);
                expect((yield* first.replica.pendingActions)[0]).toMatchObject({
                    state: "queued",
                    forwarding: false,
                    attempts: 0,
                });
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(first.view.outbox.collection.get("rename")).toMatchObject({
                            status: "queued",
                            attemptStage: "execution",
                            attempts: 0,
                        })
                    )
                );
                yield* second.replica.syncOnce;
                yield* Effect.promise(async () => {
                    await second.view.outbox.collection._sync.loadSubset({});
                });
                expect((yield* second.replica.pendingActions).map((entry) => entry.invocation.id)).toEqual([
                    "rename",
                ]);
                expect((yield* second.replica.get("Note", "one"))?.title).toBe("Pending");
                // Closing the tab cancels its local completion waiter, while the accepted action remains owned.
                void queued.completed.catch(() => undefined);
                yield* Scope.close(first.scope, Exit.void);
                expect((yield* owner.pending).length).toBe(1);
                const dispatch = yield* Effect.forkChild(owner.syncOnce);
                yield* Deferred.await(executing);
                yield* second.replica.syncOnce;
                yield* Effect.promise(() =>
                    vi.waitFor(() =>
                        expect(second.view.outbox.collection.get("rename")).toMatchObject({
                            status: "sending",
                            attemptStage: "execution",
                            attempts: 1,
                        })
                    )
                );
                yield* second.replica.syncOnce;
                expect((yield* second.replica.pendingActions)[0]).toMatchObject({
                    state: "sending",
                    forwarding: false,
                    attempts: 1,
                });
                yield* Deferred.succeed(allowExecute, undefined);
                yield* Fiber.join(dispatch);
                yield* second.replica.syncOnce;
                expect(yield* second.replica.pendingActions).toEqual([]);
                expect((yield* second.replica.receipt("rename"))?.outcome).toBe("committed");
                expect((yield* second.replica.get("Note", "one"))?.title).toBe("Pending");
            })
        )
    );
});
