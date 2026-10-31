import { BackendError } from "@party-stack/ontology-backend";
import { makeOwnedBackend, type OwnedTransaction } from "@party-stack/ontology-backend/owned";
import { o, type OntologyIR } from "@party-stack/ontology-spec";
import { eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Exit, Scope, Stream } from "effect";
import fc from "fast-check";
import { expect, test } from "vitest";
import { makeReplica, replicaStateSource } from "./index.js";

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

test("generated speculative updates, removals and rollbacks agree with the selected-snapshot oracle", async () => {
    await fc.assert(
        fc.asyncProperty(
            fc.array(fc.constantFrom("increment", "remove", "rollback", "commit"), { maxLength: 20 }),
            async (operations) => {
                await Effect.runPromise(
                    Effect.scoped(
                        Effect.gen(function* () {
                            const owned = yield* setup();
                            yield* owned.applyAction(action("seed"));
                            const parent = yield* makeReplica({
                                namespace: "property-parent",
                                ir,
                                tables: yield* Memory.make(),
                                execute,
                                backend: owned,
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
                            yield* child.retainLocal("Counter");
                            yield* oracle.retainLocal("Counter");
                            const opened = yield* child.openParentDelivery(source);
                            yield* Stream.runForEach(opened.subscription.frames, (frame) =>
                                child
                                    .receiveDelivery(frame)
                                    .pipe(
                                        Effect.flatMap((installed) =>
                                            installed
                                                ? opened.subscription.acknowledge(installed.position)
                                                : Effect.void
                                        )
                                    )
                            ).pipe(Effect.forkScoped);
                            const session = yield* source.openClient();
                            const view = {
                                generation: 1,
                                selection: { subsets: [{ objectType: "Counter" }], actionIds: [] },
                            };
                            for (const [index, operation] of operations.entries()) {
                                if (operation === "commit") yield* parent.syncOnce;
                                else if (operation === "rollback") {
                                    const queued = (yield* parent.pending)[0];
                                    if (queued) yield* parent.remove(queued.invocation.id);
                                } else yield* parent.enqueue(action(`generated-${index}`, operation));
                                const snapshot = yield* source.read(session, view);
                                yield* oracle.receiveParentState(snapshot.state);
                                const expected = yield* oracle.loadSubset("Counter");
                                const confirmed = yield* oracle.confirmed.loadSubset("Counter");
                                yield* until(
                                    Effect.gen(function* () {
                                        return (
                                            JSON.stringify(yield* child.loadSubset("Counter")) ===
                                                JSON.stringify(expected) &&
                                            JSON.stringify(yield* child.confirmed.loadSubset("Counter")) ===
                                                JSON.stringify(confirmed)
                                        );
                                    })
                                );
                                expect(yield* child.loadSubset("Counter")).toEqual(expected);
                                expect(yield* child.confirmed.loadSubset("Counter")).toEqual(
                                    yield* oracle.confirmed.loadSubset("Counter")
                                );
                            }
                        })
                    )
                );
            }
        ),
        { numRuns: 40 }
    );
});

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
