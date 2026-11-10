import { it } from "@effect/vitest";
import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as q from "@party-stack/ontology-spec/query";
import { eq, field, inArray } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit, Scope, Stream, Deferred, Fiber, Schema, PubSub } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { replicaStateSource as publicSource } from "./infrastructure.js";
import { makeReplica as makePublicReplica } from "./service.js";
import { makeReplica, replicaStateSource } from "./testing.js";

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
    actionTypes: ["increment", "remove"].map((name) => ({
        name,
        displayName: name,
        parameters: [],
        logic: [],
    })),
};
const execute = Effect.fnUntraced(function* (tx: OwnedTransaction, action: { name: string }) {
    if (action.name === "remove") yield* tx.delete("Counter", "one");
    else {
        const previous = yield* tx.get("Counter", "one");
        yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
    }
});
const action = (id: string, name = "increment") => ({ id, name, parameters: {} });

test.each(["committed", "speculative"] as const)(
    "local inspection roots do not replace a %s upstream selection",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const authority = yield* setup();
                    const parent = yield* makeReplica({
                        ir,
                        namespace: "inspection-parent",
                        tables: yield* Memory.make(),
                        backend: authority,
                        execute,
                        startSync: false,
                    });
                    const child = yield* makeReplica({
                        ir,
                        namespace: "inspection-child",
                        tables: yield* Memory.make(),
                        ...(kind === "speculative"
                            ? { source: replicaStateSource(parent) }
                            : { backend: authority }),
                        execute,
                        startSync: false,
                    });
                    const before = yield* child.parentDeliveryGeneration;
                    yield* child.retainLocal("Counter");
                    expect(yield* child.parentDeliveryGeneration).toBe(before);
                    expect((yield* parent.status).demands).toEqual([]);
                    // A real app query still changes selection and acquires upstream demand.
                    yield* child.demand({ objectType: "Counter" });
                    expect(yield* child.parentDeliveryGeneration).toBeGreaterThan(before);
                })
            )
        );
    }
);
const until = (condition: Effect.Effect<boolean, BackendError>) =>
    Effect.gen(function* () {
        while (!(yield* condition)) yield* Effect.sleep(2);
    }).pipe(Effect.timeout("3 seconds"));
const setup = Effect.fnUntraced(function* () {
    return yield* makeOwnedBackend({
        namespace: "authority",
        ir,
        tables: yield* Memory.make(),
        mutators: { increment: execute, remove: execute },
    });
});

test("pinned rows request bounded key batches without duplicate per-row selections", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const parent = yield* makeReplica({
                    namespace: "pin-batch-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend: yield* setup(),
                    execute,
                    startSync: false,
                });
                const child = yield* makeReplica({
                    namespace: "pin-batch-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: replicaStateSource(parent),
                    execute,
                    startSync: false,
                });
                for (let i = 0; i < 130; i++) yield* child.pin("Counter", `pin-${i}`, true);
                yield* child.openParentDelivery(replicaStateSource(parent));
                const demands = (yield* parent.status).demands;
                expect(demands).toHaveLength(2);
                const batches = demands.map((demand) => {
                    const predicate = demand.query?.where;
                    expect(predicate).toMatchObject({ op: "in", left: field("id") });
                    return predicate?.op === "in" ? predicate.values : [];
                });
                expect(batches.map((batch) => batch.length).sort((a, b) => a - b)).toEqual([2, 128]);
                expect(batches.flat().sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
                    Array.from({ length: 130 }, (_, i) => `pin-${i}`).sort((a, b) => a.localeCompare(b))
                );
            })
        )
    );
});

test("outbox inspection selects pending actions without unrelated retained outcomes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const parent = yield* makeReplica({
                    namespace: "outbox-inspection-history",
                    ir,
                    tables: yield* Memory.make(),
                    backend: yield* setup(),
                    execute,
                    startSync: false,
                });
                for (const id of ["old-result", "requested-result"]) {
                    yield* parent.enqueue(action(id));
                    yield* parent.syncOnce;
                }
                yield* parent.enqueue(action("pending-action"));
                const source = replicaStateSource(parent);
                const session = yield* source.openClient();
                const view = {
                    generation: 1,
                    selection: { subsets: [], actionIds: ["requested-result"], inspectActions: true },
                };
                const snapshot = yield* source.read(session, view);
                expect(snapshot.state.pending.map((entry) => entry.invocation.id)).toEqual([
                    "pending-action",
                ]);
                expect(snapshot.state.completed.map((entry) => entry.invocation.id)).toEqual([
                    "requested-result",
                ]);
                const subscription = yield* source.subscribe!(session, view);
                const frames = yield* subscription.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                const completed = frames.flatMap((frame) =>
                    frame.changes.flatMap((change) =>
                        change.kind === "put" && change.record.kind === "completed" ? [change.record.id] : []
                    )
                );
                expect(completed).toEqual(["requested-result"]);
                expect(yield* parent.receipt("old-result")).toBeDefined();
            })
        )
    );
});

test("reordered IN values share demand and do not replace the delivery selection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "canonical-selection",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: owned,
                });
                yield* replica.demand({
                    objectType: "Counter",
                    query: { where: inArray(field("id"), ["one", "two"]) },
                });
                const generation = yield* replica.parentDeliveryGeneration;
                yield* replica.demand({
                    objectType: "Counter",
                    query: { where: inArray(field("id"), ["two", "one", "one"]) },
                });
                expect((yield* replica.status).demands).toHaveLength(1);
                expect(yield* replica.parentDeliveryGeneration).toBe(generation);
            })
        )
    );
});

test("local action interests preserve committed delivery generation and replay an unacknowledged batch", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "committed-action-interest",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,
                    execute: () => Effect.void,
                    startSync: false,
                });
                yield* replica.demand({ objectType: "Counter" });
                const firstScope = yield* Scope.make();
                const first = yield* Scope.provide(replica.openParentDelivery(), firstScope);
                const pull = yield* Scope.provide(Stream.toPull(first.subscription.frames), firstScope);
                const frames = yield* pull;
                expect(frames).toHaveLength(1);
                const installed = yield* replica.receiveDelivery(frames[0]!);
                expect(installed?.duplicate).toBe(false);
                yield* Scope.close(firstScope, Exit.void);
                yield* replica.retainActions();
                yield* replica.enqueue(action("local"));
                expect(yield* replica.parentDeliveryGeneration).toBe(first.generation);
                const reopened = yield* replica.openParentDelivery();
                const resumePull = yield* Stream.toPull(reopened.subscription.frames);
                const replay = yield* resumePull;
                expect(replay).toEqual(frames);
                const repeated = yield* replica.receiveDelivery(replay[0]!);
                expect(repeated?.duplicate).toBe(true);
                yield* reopened.subscription.acknowledge(repeated!.position);
                expect((yield* replica.pending).map((entry) => entry.invocation.id)).toEqual(["local"]);
            })
        )
    );
});

test("returning to a committed selection replays unchanged bytes across local generations", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "committed-selection-replay",
                    ir,
                    tables: yield* Memory.make(),
                    backend: owned,
                    execute,
                    startSync: false,
                });
                yield* replica.demand({ objectType: "Counter" });
                const firstScope = yield* Scope.fork(yield* Effect.scope);
                const first = yield* Scope.provide(replica.openParentDelivery(), firstScope);
                const pull = yield* Scope.provide(Stream.toPull(first.subscription.frames), firstScope);
                const original = (yield* pull)[0]!;
                expect((yield* replica.receiveDelivery(original, first.generation))?.duplicate).toBe(false);
                // Simulate a disconnect after install but before ACK, with temporary demand meanwhile.
                yield* Scope.close(firstScope, Exit.void);
                const temporary = yield* Scope.fork(yield* Effect.scope);
                yield* Scope.provide(
                    replica.demand({ objectType: "Counter", query: { where: eq(field("id"), "one") } }),
                    temporary
                );
                expect(yield* replica.parentDeliveryGeneration).toBeGreaterThan(first.generation);
                yield* Scope.close(temporary, Exit.void);
                const reopened = yield* replica.openParentDelivery();
                expect(reopened.generation).toBeGreaterThan(first.generation);
                const resumePull = yield* Stream.toPull(reopened.subscription.frames);
                const resumed = (yield* resumePull)[0]!;
                expect(resumed).toEqual(original);
                expect((yield* replica.receiveDelivery(resumed, reopened.generation))?.duplicate).toBe(true);
                yield* reopened.subscription.acknowledge({
                    streamId: resumed.streamId,
                    sequence: resumed.sequence,
                });
                yield* owned.applyAction(action("after-resume"));
                const changed = (yield* resumePull)[0]!;
                const replaced = yield* Scope.fork(yield* Effect.scope);
                yield* Scope.provide(
                    replica.demand({ objectType: "Counter", query: { where: eq(field("id"), "one") } }),
                    replaced
                );
                expect(yield* replica.parentDeliveryGeneration).toBeGreaterThan(reopened.generation);
                expect(
                    yield* Effect.result(replica.receiveDelivery(changed, reopened.generation))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ViewReplaced" },
                });
                expect(yield* replica.confirmed.get("Counter", "one")).toBeUndefined();
            })
        )
    );
});

test("multipart delivery settles a rejection after cross-client writes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* setup();
                const rejectNow = yield* Deferred.make<void>();
                yield* authority.storage.transaction((tx) =>
                    Effect.forEach(
                        Array.from({ length: 200 }, (_, n) => n),
                        (n) => tx.put("Counter", { id: `cached-${n}`, count: n }),
                        { discard: true }
                    )
                );
                const parent = yield* makePublicReplica({
                    namespace: "reject-parent",
                    ir,
                    mutators: { increment: execute, remove: execute },
                    tables: yield* Memory.make(),
                    backend: {
                        ...authority,
                        applyAction: (request) =>
                            request.id !== "rejected"
                                ? authority.applyAction(request)
                                : Deferred.await(rejectNow).pipe(
                                      Effect.andThen(
                                          Effect.fail(
                                              new BackendError({
                                                  operation: "applyAction",
                                                  kind: "ValidationFailed",
                                                  message: "Choose a valid project.",
                                                  retryable: false,
                                                  actionOutcome: "not-committed",
                                                  issues: [
                                                      {
                                                          path: ["project"],
                                                          code: "InvalidObjectReference",
                                                          message: "Choose a valid value.",
                                                      },
                                                  ],
                                              })
                                          )
                                      )
                                  ),
                    },
                    outbox: { failureStrategy: "discard-all" },
                });
                const child = yield* makePublicReplica({
                    namespace: "reject-child",
                    ir,
                    mutators: { increment: execute, remove: execute },
                    tables: yield* Memory.make(),
                    source: publicSource(parent),
                });
                const other = yield* makePublicReplica({
                    namespace: "other-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: publicSource(parent),
                    mutators: { increment: execute, remove: execute },
                });
                const subset = { from: { source: { objectType: "Counter" }, binding: "counter" } };
                yield* child.demand.acquire(subset);
                yield* other.demand.acquire(subset);
                yield* Stream.runDrain(other.outbox.observe()).pipe(
                    Effect.forkScoped({ startImmediately: true })
                );
                yield* child.outbox.enqueue(action("first-success"));
                yield* child.outbox.wait("first-success").pipe(Effect.timeout("3 seconds"));
                yield* other.outbox.enqueue(action("second-success", "remove"));
                yield* other.outbox.wait("second-success").pipe(Effect.timeout("3 seconds"));
                yield* child.outbox.enqueue(action("rejected"));
                const waiter = yield* Effect.forkScoped(
                    Effect.result(child.outbox.wait("rejected").pipe(Effect.timeout("3 seconds")))
                );
                // Acceptance must flow while upstream execution is still held. A
                // selected stream cannot wait for a refresh gated behind that write.
                yield* child.outbox.wait("rejected", { until: "accepted" }).pipe(Effect.timeout("3 seconds"));
                yield* Deferred.succeed(rejectNow, undefined);
                const result = yield* Fiber.join(waiter);
                expect(result).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ValidationFailed", issues: [{ path: ["project"] }] },
                });
                expect(yield* child.outbox.entries).toEqual([]);
            })
        )
    );
});

test("owned selection delivery propagates inserts, updates and deletes without reloading source snapshots", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                let loads = 0;
                let pulls = 0;
                const replica = yield* makeReplica({
                    namespace: "committed-child",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: {
                        ...owned,
                        loadSubset: (query) => {
                            loads++;
                            return owned.loadSubset(query);
                        },
                        changes: {
                            ...owned.changes!,
                            pull: (request) => {
                                pulls++;
                                return owned.changes!.pull(request);
                            },
                        },
                    },
                });
                yield* replica.demand({ objectType: "Counter" });
                yield* until(
                    replica.status.pipe(
                        Effect.map((status) => status.demands[0]?.installed === status.demands[0]?.revision)
                    )
                );
                const baseline = { loads, pulls };
                yield* owned.applyAction(action("seed"));
                yield* until(replica.get("Counter", "one").pipe(Effect.map((row) => row?.count === 1)));
                yield* owned.applyAction(action("update"));
                yield* until(replica.get("Counter", "one").pipe(Effect.map((row) => row?.count === 2)));
                yield* owned.applyAction(action("delete", "remove"));
                yield* until(replica.get("Counter", "one").pipe(Effect.map((row) => row === undefined)));
                expect({ loads, pulls }).toEqual(baseline);
            })
        )
    );
});

test("speculative acceptance and confirmation use the stream without applying a second optimistic increment", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                yield* owned.applyAction(action("seed"));
                const parent = yield* makeReplica({
                    namespace: "parent",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: owned,
                    startSync: false,
                });
                yield* parent.demand({ objectType: "Counter" });
                yield* parent.syncOnce;
                const source = replicaStateSource(parent);
                let accepts = 0;
                let snapshots = 0;
                const child = yield* makeReplica({
                    namespace: "tab",
                    connectivity: { online: Effect.succeed(false), changes: Stream.never },
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    source: {
                        ...source,
                        submit: (request) => {
                            snapshots++;
                            return source.submit(request);
                        },
                        accept: (request) => {
                            accepts++;
                            return source.accept!(request);
                        },
                    },
                });
                yield* child.demand({ objectType: "Counter" });
                yield* until(child.get("Counter", "one").pipe(Effect.map((row) => row?.count === 1)));
                yield* child.enqueue(action("child-increment"));
                expect((yield* child.get("Counter", "one"))?.count).toBe(2);
                yield* until(
                    parent.pending.pipe(
                        Effect.map((entries) =>
                            entries.some((entry) => entry.invocation.id === "child-increment")
                        )
                    )
                );
                yield* until(child.pending.pipe(Effect.map((entries) => entries.length === 0)));
                expect((yield* child.get("Counter", "one"))?.count).toBe(2);
                expect((yield* child.confirmed.get("Counter", "one"))?.count).toBe(1);
                yield* parent.syncOnce;
                yield* until(
                    child
                        .actionStatus("child-increment")
                        .pipe(Effect.map((status) => status.receipt?.outcome === "committed"))
                );
                expect((yield* child.get("Counter", "one"))?.count).toBe(2);
                expect((yield* child.confirmed.get("Counter", "one"))?.count).toBe(2);
                expect(accepts).toBe(1);
                expect(snapshots).toBe(0);
            })
        )
    );
});

test("visible batches exclude unchanged rows and repair sorted windows from local storage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                const replica = yield* makeReplica({
                    namespace: "visible",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: owned,
                    startSync: false,
                });
                const batches = yield* Stream.toPull(
                    replica.observeRows("Counter", { where: eq(field("id"), "one") })
                );
                const first = yield* batches;
                expect(first[0]?.reset).toBe(true);
                yield* replica.enqueue(action("first"));
                const next = yield* batches;
                expect(next[0]?.rows.map((row) => row.value.count)).toEqual([1]);
                expect(next[0]?.reset).toBe(false);
                const scope = yield* Scope.make();
                const windows = yield* Scope.provide(
                    Stream.toPull(
                        replica.observeRows("Counter", { limit: 1, orderBy: [{ field: field("count") }] })
                    ),
                    scope
                );
                yield* windows;
                yield* replica.enqueue(action("second"));
                const window = yield* windows;
                expect(window[0]?.reset).toBe(true);
                expect(window[0]?.rows.map((row) => row.value.count)).toEqual([2]);
                yield* Scope.close(scope, Exit.void);
            })
        )
    );
});

test("delivery and action forwarding share one delayed parent session acquisition", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const parent = yield* makeReplica({
                    namespace: "delayed-parent",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: yield* setup(),
                    startSync: false,
                });
                const source = replicaStateSource(parent);
                let acquisitions = 0;
                const child = yield* makeReplica({
                    namespace: "delayed-child",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    source: {
                        ...source,
                        openClient: (token) =>
                            Effect.gen(function* () {
                                acquisitions++;
                                yield* Effect.sleep(20);
                                return yield* source.openClient(token);
                            }),
                    },
                });
                yield* child.demand({ objectType: "Counter" });
                yield* child.enqueue(action("delayed-action"));
                yield* until(parent.pending.pipe(Effect.map((entries) => entries.length === 1)));
                yield* until(child.pending.pipe(Effect.map((entries) => entries.length === 0)));
                expect((yield* child.get("Counter", "one"))?.count).toBe(1);
                expect((yield* child.status).replicationError).toBeUndefined();
                expect(acquisitions).toBe(1);
            })
        )
    );
});

test("persisted-only readers preserve cached rows without selecting new upstream subsets", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                yield* owned.applyAction(action("seed"));
                const selected: number[] = [];
                const replica = yield* makeReplica({
                    namespace: "local-reader",
                    ir,
                    execute,
                    tables: yield* Memory.make(),
                    backend: {
                        ...owned,
                        subscribeSelection: (selection) => {
                            selected.push(selection.subsets.length);
                            return owned.subscribeSelection!(selection);
                        },
                    },
                });
                const demandScope = yield* Scope.make();
                yield* Scope.provide(replica.demand({ objectType: "Counter" }), demandScope);
                yield* replica.syncOnce;
                yield* until(replica.get("Counter", "one").pipe(Effect.map((row) => row?.count === 1)));
                yield* replica.retainLocal("Counter");
                yield* Scope.close(demandScope, Exit.void);
                yield* until(Effect.sync(() => selected.at(-1) === 0));
                yield* replica.syncOnce;
                expect((yield* replica.get("Counter", "one"))?.count).toBe(1);
                expect((yield* replica.status).demands).toEqual([]);
                const afterRelease = selected.length;
                yield* replica.retainLocal("Counter", { where: eq(field("count"), 100) });
                yield* replica.syncOnce;
                expect(selected.length).toBe(afterRelease);
            })
        )
    );
});

const DeliveryScenario = Schema.Struct({
    operations: Schema.Array(
        Schema.Literals(["increment", "remove", "rollback", "commit", "reject", "reconnect", "lostReply"])
    ).check(Schema.isMaxLength(20)),
    schedule: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(10)
    ),
    duplicateFrames: Schema.Boolean,
});

it.live.prop(
    "generated speculative updates, reconnects and acknowledgment schedules agree with the selected-snapshot oracle",
    [DeliveryScenario],
    ([{ operations, schedule, duplicateFrames }]) =>
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                yield* owned.applyAction(action("seed"));
                let boundary = 0;
                // Generate reproducible scheduling at transport/publication
                // boundaries without changing the production Effect scheduler.
                const pause = Effect.suspend(() =>
                    Effect.forEach(
                        Array.from({ length: schedule[boundary++ % schedule.length]! }),
                        () => Effect.yieldNow,
                        { discard: true }
                    )
                );
                const rejected = new Set<string>();
                const lostReplies = new Set<string>();
                const parent = yield* makeReplica({
                    namespace: "property-parent",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: {
                        ...owned,
                        applyAction: Effect.fnUntraced(function* (request) {
                            if (rejected.has(request.id))
                                return yield* new BackendError({
                                    operation: "applyAction",
                                    kind: "ValidationFailed",
                                    message: "Rejected input.",
                                    retryable: false,
                                    actionOutcome: "not-committed",
                                });
                            const receipt = yield* owned.applyAction(request);
                            if (lostReplies.delete(request.id))
                                return yield* new BackendError({
                                    operation: "applyAction",
                                    kind: "Unavailable",
                                    message: "Reply lost after commit.",
                                    retryable: true,
                                    actionOutcome: "unknown",
                                });
                            return receipt;
                        }),
                    },
                    outbox: { failureStrategy: "discard-all", retryDelayMs: 0 },
                    publish: pause,
                    startSync: false,
                });
                yield* parent.demand({ objectType: "Counter" });
                yield* parent.syncOnce;
                const source = replicaStateSource(parent);
                const child = yield* makeReplica({
                    namespace: "property-child",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    source,
                    startSync: false,
                });
                const oracle = yield* makeReplica({
                    namespace: "snapshot-oracle",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    source,
                    startSync: false,
                });
                yield* child.demand({ objectType: "Counter" });
                yield* oracle.demand({ objectType: "Counter" });
                yield* child.retainActions();
                yield* oracle.retainActions();
                // Compare the two delivery strategies under the same explicit
                // result interest, including actions that finish between captures.
                const actionIds = operations.flatMap((operation, index) =>
                    operation === "lostReply"
                        ? [`lost-reply-${index}`]
                        : operation === "reject"
                          ? [`rejected-${index}`]
                          : operation === "increment" || operation === "remove"
                            ? [`generated-${index}`]
                            : []
                );
                yield* child.retainActions(actionIds);
                const owner = yield* Effect.scope;
                const connect = Effect.fnUntraced(function* () {
                    const scope = yield* Scope.fork(owner);
                    yield* Scope.provide(
                        Effect.gen(function* () {
                            const opened = yield* child.openParentDelivery(source);
                            yield* Stream.runForEach(opened.subscription.frames, (frame) =>
                                pause.pipe(
                                    Effect.andThen(child.receiveDelivery(frame, opened.generation)),
                                    Effect.tap(() =>
                                        duplicateFrames
                                            ? pause.pipe(
                                                  Effect.andThen(
                                                      child.receiveDelivery(frame, opened.generation)
                                                  ),
                                                  Effect.asVoid
                                              )
                                            : Effect.void
                                    ),
                                    Effect.flatMap((installed) =>
                                        installed
                                            ? pause.pipe(
                                                  Effect.andThen(
                                                      opened.subscription.acknowledge(installed.position)
                                                  )
                                              )
                                            : Effect.void
                                    )
                                )
                            ).pipe(Effect.forkScoped);
                        }),
                        scope
                    );
                    return scope;
                });
                let connection = yield* connect();
                const session = yield* source.openClient();
                const view = {
                    generation: 1,
                    selection: {
                        subsets: [{ objectType: "Counter" }],
                        actionIds,
                        inspectActions: true,
                    },
                };
                for (const [index, operation] of operations.entries()) {
                    if (operation === "reconnect") {
                        // The preceding comparison can observe installed rows
                        // before their delayed acknowledgment reaches the parent.
                        yield* Scope.close(connection, Exit.void);
                        connection = yield* connect();
                    } else if (operation === "lostReply") {
                        const id = `lost-reply-${index}`;
                        lostReplies.add(id);
                        yield* parent.enqueue(action(id));
                        yield* Effect.result(parent.syncOnce);
                        yield* parent.syncOnce;
                        // The snapshot oracle shares parent state, so also check
                        // the authority journal independently for duplicate commits.
                        const journal = yield* owned.changes!.pull({});
                        if (journal.commits.filter((commit) => commit.operationId === id).length !== 1)
                            return false;
                    } else if (operation === "reject") {
                        const id = `rejected-${index}`;
                        rejected.add(id);
                        yield* parent.enqueue(action(id));
                        yield* Effect.result(parent.syncOnce);
                    } else if (operation === "commit") yield* parent.syncOnce;
                    else if (operation === "rollback") {
                        const queued = (yield* parent.pending)[0];
                        if (queued) yield* parent.remove(queued.invocation.id);
                    } else yield* parent.enqueue(action(`generated-${index}`, operation));
                    const snapshot = yield* source.read(session, view);
                    yield* oracle.receiveParentState(snapshot.state);
                    const expected = yield* oracle.loadSubset("Counter");
                    const confirmed = yield* oracle.confirmed.loadSubset("Counter");
                    const actions = (state: Awaited<Effect.Success<typeof oracle.parentState>>) =>
                        JSON.stringify({ pending: state?.pending, completed: state?.completed });
                    const expectedActions = actions(yield* oracle.parentState);
                    yield* until(
                        Effect.gen(function* () {
                            return (
                                JSON.stringify(yield* child.loadSubset("Counter")) ===
                                    JSON.stringify(expected) &&
                                JSON.stringify(yield* child.confirmed.loadSubset("Counter")) ===
                                    JSON.stringify(confirmed) &&
                                actions(yield* child.parentState) === expectedActions
                            );
                        })
                    );
                    if (
                        JSON.stringify(yield* child.loadSubset("Counter")) !== JSON.stringify(expected) ||
                        JSON.stringify(yield* child.confirmed.loadSubset("Counter")) !==
                            JSON.stringify(confirmed) ||
                        actions(yield* child.parentState) !== expectedActions
                    )
                        return false;
                }
                return true;
            })
        ),
    { arbitrary: { runs: 80 }, timeout: 30_000 }
);

test("invalid replication data stops delivery, exposes a diagnostic and preserves pending actions", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                yield* owned.applyAction(action("seed"));
                const tables = yield* Memory.make();
                const previousScope = yield* Scope.make();
                const previous = yield* Scope.provide(
                    makeReplica({
                        namespace: "malformed",
                        ir,
                        tables,
                        execute,
                        backend: owned,
                        startSync: false,
                    }),
                    previousScope
                );
                yield* previous.syncOnce;
                yield* previous.enqueue(action("unsubmitted"));
                yield* Scope.close(previousScope, Exit.void);
                const replica = yield* makeReplica({
                    namespace: "malformed",
                    ir,
                    tables,
                    execute,
                    connectivity: { online: Effect.succeed(false), changes: Stream.never },
                    backend: {
                        ...owned,
                        subscribeSelection: (selection) =>
                            owned.subscribeSelection!(selection).pipe(
                                Effect.map((subscription) => ({
                                    ...subscription,
                                    frames: subscription.frames.pipe(
                                        Stream.map((frame) => ({
                                            ...frame,
                                            changes: frame.changes.map((change) =>
                                                change.kind === "put" && change.record.kind === "base"
                                                    ? {
                                                          ...change,
                                                          record: {
                                                              ...change.record,
                                                              value: {
                                                                  ...change.record.value,
                                                                  id: "wrong-key",
                                                              },
                                                          },
                                                      }
                                                    : change
                                            ),
                                        }))
                                    ),
                                }))
                            ),
                    },
                });
                yield* replica.demand({ objectType: "Counter" });
                yield* until(
                    replica.status.pipe(Effect.map((status) => status.replicationError?.recovery === "stop"))
                );
                expect((yield* replica.status).replicationError?.kind).toBe("InvalidResponse");
                expect((yield* replica.pending)[0]).toMatchObject({
                    invocation: { id: "unsubmitted" },
                    state: "queued",
                    attempts: 0,
                });
                expect((yield* replica.get("Counter", "one"))?.count).toBe(2);
                expect((yield* replica.confirmed.get("Counter", "one"))?.count).toBe(1);
            })
        )
    );
});

test("optional undefined query settings keep coverage identity after schema decoding", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const owned = yield* setup();
                yield* owned.applyAction(action("seed"));
                const replica = yield* makeReplica({
                    namespace: "query-identity",
                    ir,
                    execute,
                    backend: owned,
                    tables: yield* Memory.make(),
                });
                yield* replica.demand({
                    objectType: "Counter",
                    query: {
                        where: eq(field("id"), "one"),
                        orderBy: [{ field: field("count"), direction: undefined, nulls: undefined }],
                        limit: undefined,
                        offset: undefined,
                        after: undefined,
                    },
                });
                yield* replica.syncOnce;
                const demand = (yield* replica.status).demands[0]!;
                expect(demand.installed).toBe(demand.revision);
                expect((yield* replica.get("Counter", "one"))?.count).toBe(1);
            })
        )
    );
});

test("a readiness transition is delivered even when children capture the earlier incomplete coverage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* setup();
                yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
                const parent = yield* makeReplica({
                    namespace: "readiness-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend: {
                        ...authority,
                        changes: undefined,
                        subscribeSelection: undefined,
                        watchSubset: () => Effect.succeed(Stream.never),
                    },
                    execute,
                    // Make the first notification observable before the load completes
                    // its in-memory readiness bookkeeping, as asynchronous stores can do.
                    publish: Effect.sleep(30),
                });
                const child = yield* makePublicReplica({
                    namespace: "readiness-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: replicaStateSource(parent),
                    mutators: { increment: execute },
                });
                yield* child.demand
                    .acquire({ from: { source: { objectType: "Counter" }, binding: "row" } })
                    .pipe(Effect.timeout("1 second"));
                expect(yield* child.confirmed.get("Counter", "one")).toEqual({ id: "one", count: 1 });
            })
        )
    );
});

test("idle demand retention preserves upstream watches across child selection replacement", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* setup();
                let starts = 0,
                    stops = 0;
                const parent = yield* makeReplica({
                    namespace: "selection-watch-retention",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    demand: { idleRetentionMs: 5_000 },
                    backend: {
                        ...authority,
                        changes: undefined,
                        subscribeSelection: undefined,
                        watchSubset: () =>
                            Effect.acquireRelease(
                                Effect.sync(() => {
                                    starts++;
                                    return Stream.never;
                                }),
                                () =>
                                    Effect.sync(() => {
                                        stops++;
                                    })
                            ),
                    },
                });
                const source = replicaStateSource(parent);
                const client = yield* source.openClient();
                const selection = { subsets: [{ objectType: "Counter" }], actionIds: [] as string[] };
                const first = yield* Scope.make();
                yield* Scope.provide(source.subscribe!(client, { generation: 1, selection }), first);
                expect(starts).toBe(1);
                yield* Scope.close(first, Exit.void);
                expect(stops).toBe(0);
                const second = yield* Scope.make();
                yield* Scope.provide(
                    source.subscribe!(client, {
                        generation: 2,
                        selection: { ...selection, actionIds: ["observe-result"] },
                    }),
                    second
                );
                expect(starts).toBe(1);
                yield* Scope.close(second, Exit.void);
                yield* TestClock.adjust(5_001);
                expect(stops).toBe(1);
                expect((yield* parent.status).demands).toEqual([]);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test.each(["committed", "speculative"] as const)(
    "a held full %s collection covers filtered demands without replacing delivery",
    async (kind) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const authority = yield* setup();
                    yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
                    const parent = yield* makeReplica({
                        namespace: "covering-parent",
                        ir,
                        tables: yield* Memory.make(),
                        backend: authority,
                        execute,
                    });
                    const child = yield* makeReplica({
                        namespace: "covered-child",
                        ir,
                        tables: yield* Memory.make(),
                        execute,
                        ...(kind === "committed"
                            ? { backend: authority }
                            : { source: replicaStateSource(parent) }),
                    });
                    const whole = yield* Scope.make();
                    yield* Scope.provide(
                        child
                            .demand({ objectType: "Counter" })
                            .pipe(Effect.andThen(child.syncSubset({ objectType: "Counter" }))),
                        whole
                    );
                    const generation = yield* child.parentDeliveryGeneration;
                    yield* child
                        .demand({ objectType: "Counter", query: { where: eq(field("count"), 2) } })
                        .pipe(Effect.timeout("250 millis"));
                    yield* child
                        .syncSubset({ objectType: "Counter", query: { where: eq(field("count"), 2) } })
                        .pipe(Effect.timeout("250 millis"));
                    expect(yield* child.loadSubset("Counter", { where: eq(field("count"), 2) })).toEqual([]);
                    expect(
                        (yield* child.snapshotSubset({
                            objectType: "Counter",
                            query: { where: eq(field("count"), 2) },
                        })).complete
                    ).toBe(true);
                    const filtered = (yield* child.status).demands.find((demand) => demand.query?.where);
                    expect(filtered?.coveredBy?.objectType).toBe("Counter");
                    expect(filtered?.installed).toBe(filtered?.revision);
                    expect(yield* child.parentDeliveryGeneration).toBe(generation);
                    yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 2 }));
                    yield* until(child.get("Counter", "one").pipe(Effect.map((row) => row?.count === 2)));
                    expect(yield* child.loadSubset("Counter", { where: eq(field("count"), 2) })).toHaveLength(
                        1
                    );
                    yield* Scope.close(whole, Exit.void);
                    yield* until(
                        child.parentDeliveryGeneration.pipe(Effect.map((value) => value > generation))
                    );
                })
            )
        );
    }
);

test("covered demand does not wait for an unrelated replacement selection", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const definition = {
                    ...ir,
                    objectTypes: [...ir.objectTypes, { ...ir.objectTypes[0]!, name: "Other" }],
                };
                const authority = yield* makeOwnedBackend({
                    namespace: "unrelated-authority",
                    ir: definition,
                    tables: yield* Memory.make(),
                    mutators: { increment: execute, remove: execute },
                });
                yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
                const parent = yield* makeReplica({
                    namespace: "independent-parent",
                    ir: definition,
                    tables: yield* Memory.make(),
                    backend: authority,
                    execute,
                });
                const source = replicaStateSource(parent);
                const held = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                let hold = false;
                const child = yield* makePublicReplica({
                    namespace: "independent-child",
                    ir: definition,
                    tables: yield* Memory.make(),
                    source: {
                        ...source,
                        subscribe: (...args) =>
                            source.subscribe!(...args).pipe(
                                Effect.map((subscription) => ({
                                    ...subscription,
                                    frames: hold
                                        ? Stream.unwrap(
                                              Deferred.succeed(held, undefined).pipe(
                                                  Effect.andThen(Deferred.await(release)),
                                                  Effect.as(subscription.frames)
                                              )
                                          )
                                        : subscription.frames,
                                }))
                            ),
                    },
                });
                const first = { from: { source: { objectType: "Counter" }, binding: "row" } };
                yield* child.demand.acquire(first);
                hold = true;
                const other = yield* child.demand
                    .acquire({
                        from: { source: { objectType: "Other" }, binding: "other" },
                    })
                    .pipe(Effect.scoped, Effect.forkScoped);
                yield* Deferred.await(held);
                yield* child.demand.acquire(first).pipe(Effect.scoped, Effect.timeout("100 millis"));
                expect(yield* child.confirmed.get("Counter", "one")).toEqual({ id: "one", count: 1 });
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(other);
            })
        )
    );
});

test("a narrower live filter reuses installed region coverage while replacement delivery is held", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* setup();
                yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
                const parent = yield* makeReplica({
                    namespace: "filtered-parent",
                    ir,
                    tables: yield* Memory.make(),
                    backend: authority,
                    execute,
                });
                const source = replicaStateSource(parent);
                const held = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                let hold = false;
                const child = yield* makePublicReplica({
                    namespace: "filtered-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: {
                        ...source,
                        subscribe: (...args) =>
                            source.subscribe!(...args).pipe(
                                Effect.map((subscription) => ({
                                    ...subscription,
                                    frames: hold
                                        ? Stream.unwrap(
                                              Deferred.succeed(held, undefined).pipe(
                                                  Effect.andThen(Deferred.await(release)),
                                                  Effect.as(subscription.frames)
                                              )
                                          )
                                        : subscription.frames,
                                }))
                            ),
                    },
                });
                const broad = {
                    from: { source: { objectType: "Counter" }, binding: "row" },
                    where: q.eq(q.field("row", "count"), q.literal(1)),
                };
                yield* child.demand.acquire(broad);
                hold = true;
                const narrow = {
                    ...broad,
                    where: q.and(broad.where, q.eq(q.field("row", "id"), q.literal("one"))),
                };
                yield* child.demand.acquire(narrow).pipe(Effect.timeout("250 millis"));
                yield* Deferred.await(held).pipe(Effect.timeout("250 millis"));
                expect(yield* child.readSubset(narrow)).toEqual([
                    { key: "one", value: { id: "one", count: 1 } },
                ]);
                yield* Deferred.succeed(release, undefined);
            })
        )
    );
});

test("overlapping subset hints invalidate each coverage row once until it is refreshed", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* setup();
                const tables = yield* Memory.make();
                const hints = yield* PubSub.sliding<void>(1);
                let watchers = 0;
                let transactions = 0;
                let coverageWrites = 0;
                const count = 12;
                const replica = yield* makeReplica({
                    namespace: "overlapping-invalidation",
                    ir,
                    execute,
                    startSync: false,
                    tables: {
                        ...tables,
                        transaction: (body) =>
                            tables
                                .transaction((tx) =>
                                    body({
                                        ...tx,
                                        put: (table, key, value) => {
                                            if (table.name.endsWith('"coverage"]')) coverageWrites++;
                                            return tx.put(table, key, value);
                                        },
                                    })
                                )
                                .pipe(
                                    Effect.tap(() =>
                                        Effect.sync(() => {
                                            transactions++;
                                        })
                                    )
                                ),
                    },
                    backend: {
                        ...authority,
                        changes: undefined,
                        subscribeSelection: undefined,
                        watchSubset: () =>
                            Effect.gen(function* () {
                                const subscription = yield* PubSub.subscribe(hints);
                                watchers++;
                                return Stream.fromSubscription(subscription);
                            }),
                    },
                });
                for (let i = 0; i < count; i++)
                    yield* replica.demand({ objectType: "Counter", query: { where: eq(field("count"), i) } });
                yield* until(Effect.sync(() => watchers === count));
                for (let round = 0; round < 2; round++) {
                    yield* replica.syncOnce;
                    coverageWrites = 0;
                    const before = transactions;
                    yield* PubSub.publish(hints, undefined);
                    yield* until(Effect.sync(() => transactions >= before + count));
                    expect(coverageWrites).toBe(count);
                }
            })
        )
    );
});

test("an invalidation during snapshot IO prevents publishing that snapshot as complete coverage", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const authority = yield* setup();
                yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
                const started = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const hints = yield* PubSub.sliding<void>(1);
                let loads = 0;
                const parent = yield* makeReplica({
                    namespace: "invalidated-fetch-parent",
                    ir,
                    tables: yield* Memory.make(),
                    execute,
                    backend: {
                        ...authority,
                        changes: undefined,
                        subscribeSelection: undefined,
                        watchSubset: () => PubSub.subscribe(hints).pipe(Effect.map(Stream.fromSubscription)),
                        loadSubset: Effect.fnUntraced(function* (request) {
                            const snapshot = yield* authority.loadSubset(request);
                            if (++loads === 1) {
                                yield* Deferred.succeed(started, undefined);
                                yield* Deferred.await(release);
                            }
                            return snapshot;
                        }),
                    },
                });
                const child = yield* makePublicReplica({
                    namespace: "invalidated-fetch-child",
                    ir,
                    tables: yield* Memory.make(),
                    source: replicaStateSource(parent),
                });
                const waiting = yield* child.demand
                    .acquire({
                        from: { source: { objectType: "Counter" }, binding: "row" },
                    })
                    .pipe(Effect.forkScoped);
                yield* Deferred.await(started);
                yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 2 }));
                yield* PubSub.publish(hints, undefined);
                yield* until(
                    parent.status.pipe(
                        Effect.map((status) => status.demands.some((demand) => demand.revision > 1))
                    )
                );
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(waiting).pipe(Effect.timeout("1 second"));
                expect(yield* child.confirmed.get("Counter", "one")).toEqual({ id: "one", count: 2 });
                expect(loads).toBeGreaterThanOrEqual(2);
            })
        )
    );
});

test.each(["complete", "invalid", "cancel"] as const)(
    "delivery readiness stays scoped during a slow initial transfer: %s",
    async (outcome) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const authority = yield* setup();
                    yield* authority.storage.transaction((tx) => tx.put("Counter", { id: "one", count: 1 }));
                    const started = yield* Deferred.make<void>();
                    const release = yield* Deferred.make<void>();
                    const child = yield* makePublicReplica({
                        namespace: "slow-delivery",
                        ir,
                        tables: yield* Memory.make(),
                        backend: {
                            ...authority,
                            subscribeSelection: (...args) =>
                                authority.subscribeSelection!(...args).pipe(
                                    Effect.map((subscription) => ({
                                        ...subscription,
                                        frames: subscription.frames.pipe(
                                            Stream.tap(() =>
                                                Deferred.succeed(started, undefined).pipe(
                                                    Effect.andThen(Deferred.await(release)),
                                                    Effect.andThen(
                                                        outcome === "invalid"
                                                            ? Effect.fail(
                                                                  new BackendError({
                                                                      operation: "test.delivery",
                                                                      kind: "InvalidResponse",
                                                                      retryable: false,
                                                                      message: "Malformed source data.",
                                                                  })
                                                              )
                                                            : Effect.void
                                                    )
                                                )
                                            )
                                        ),
                                    }))
                                ),
                        },
                    });
                    const waiting = yield* child.demand
                        .acquire({
                            from: { source: { objectType: "Counter" }, binding: "row" },
                        })
                        .pipe(Effect.scoped, Effect.forkScoped);
                    yield* Deferred.await(started);
                    yield* TestClock.adjust(11_000);
                    expect(waiting.pollUnsafe()).toBeUndefined();
                    if (outcome === "cancel") {
                        yield* Fiber.interrupt(waiting);
                        expect((yield* child.status.get).demands).toEqual([]);
                        return;
                    }
                    yield* Deferred.succeed(release, undefined);
                    const result = yield* Effect.result(Fiber.join(waiting));
                    if (outcome === "invalid") {
                        expect(result).toMatchObject({
                            _tag: "Failure",
                            failure: { kind: "InvalidResponse" },
                        });
                    } else {
                        expect(result._tag).toBe("Success");
                        expect(yield* child.confirmed.get("Counter", "one")).toEqual({ id: "one", count: 1 });
                    }
                })
            ).pipe(Effect.provide(TestClock.layer()))
        );
    }
);
