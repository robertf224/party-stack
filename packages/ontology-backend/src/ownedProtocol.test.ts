import { o, type OntologyIR } from "@party-stack/ontology-spec";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeOwnedBackend } from "./owned.js";
import { BackendError } from "./index.js";
import type { ClientPolicy } from "./clients.js";
import type { ActionRequest } from "./index.js";

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
    actionTypes: ["increment", "fail"].map((name) => ({
        name,
        displayName: name,
        logic: [],
        parameters: [],
    })),
};
const invocation = (id: string, name = "increment"): ActionRequest => ({ id, name, parameters: {} });
const setup = Effect.fnUntraced(function* (clients?: ClientPolicy, maxCommits?: number) {
    const tables = yield* Memory.make();
    const options = {
        namespace: "owned-protocol",
        ir,
        tables,
        clients,
        history: { maxCommits },
        mutators: Object.fromEntries(
            ["increment", "fail"].map((name) => [
                name,
                Effect.fnUntraced(function* (tx: import("./owned.js").OwnedTransaction) {
                    const previous = yield* tx.get("Counter", "one");
                    yield* tx.put("Counter", { id: "one", count: Number(previous?.count ?? 0) + 1 });
                    if (name === "fail")
                        return yield* new BackendError({
                            operation: "test",
                            kind: "ValidationFailed",
                            message: "Reject after write.",
                            retryable: false,
                        });
                }),
            ])
        ),
    };
    const backend = yield* makeOwnedBackend(options);
    const source = backend.protocol;
    const session = yield* source.openClient();
    return { tables, options, backend, source, session };
});

test("owned replay history is bounded and expired cursors require a coordinated snapshot", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup(undefined, 2);
            const before = yield* f.backend.loadSubset({ objectType: "Counter" });
            for (let sequence = 1; sequence <= 5; sequence++) {
                const batch = yield* f.source.submit({
                    session: f.session,
                    sequence,
                    invocation: invocation(`action-${sequence}`),
                    optimistic: true,
                });
                yield* f.source.acknowledge(f.session, batch.state.revision, batch.client.deliveredThrough);
            }
            const expired = yield* Effect.result(f.backend.changes!.pull({ cursor: before.cursor }));
            expect(expired).toMatchObject({ _tag: "Failure", failure: { kind: "HistoryExpired" } });
            expect((yield* Effect.result(f.backend.changes!.pull({})))._tag).toBe("Failure");
            const snapshot = yield* f.backend.loadSubset({ objectType: "Counter" });
            expect(snapshot.rows[0]?.value.count).toBe(5);
            expect((yield* f.backend.changes!.pull({ cursor: snapshot.cursor })).commits).toEqual([]);
            const journal = yield* f.tables.loadSubset(
                Table.make({ name: JSON.stringify(["backend", f.options.namespace, "journal"]) })
            );
            expect(journal).toHaveLength(2);
            expect(journal.map((row) => row.key)).toEqual([4, 5]);
            const current = yield* f.source.read(f.session);
            expect(current.state.completed).toEqual([]);
            expect(current.state.objects[0]?.base[0]?.value.count).toBe(5);
        })
    );
});

test("an owned protocol source commits actions directly, without a Replica outbox", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup();
            const request = {
                session: f.session,
                sequence: 1,
                invocation: invocation("one"),
                optimistic: true,
            };
            const first = yield* f.source.submit(request);
            const duplicate = yield* f.source.submit(request);
            expect(first.state.pending).toEqual([]);
            expect(first.state.completed[0]?.receipt?.outcome).toBe("committed");
            expect(duplicate.state).toEqual(first.state);
            expect(first.client.acceptedThrough).toBe(1);
            expect(first.state.objects[0]?.base[0]?.value.count).toBe(1);
            expect((yield* f.backend.changes!.pull({})).commits).toHaveLength(1);
            expect(
                yield* f.tables.loadSubset(
                    Table.make({ name: JSON.stringify(["replica", f.options.namespace, "outbox"]) })
                )
            ).toEqual([]);
            // Ordered client identity protects protocol requests, so it does not also
            // accumulate the legacy arbitrary-invocation receipt table.
            expect(
                yield* f.tables.loadSubset(
                    Table.make({ name: JSON.stringify(["backend", f.options.namespace, "receipts"]) })
                )
            ).toEqual([]);
            expect(
                (yield* Effect.result(f.source.submit({ ...request, invocation: invocation("different") })))
                    ._tag
            ).toBe("Failure");
        })
    );
});

test("owned client progress rolls back with a failed action and survives reopen", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup();
            expect(
                (yield* Effect.result(
                    f.source.submit({
                        session: f.session,
                        sequence: 1,
                        invocation: invocation("bad", "fail"),
                        optimistic: true,
                    })
                ))._tag
            ).toBe("Failure");
            expect((yield* f.source.read(f.session)).client.acceptedThrough).toBe(0);
            expect((yield* f.backend.loadSubset({ objectType: "Counter" })).rows).toEqual([]);
            yield* f.source.submit({
                session: f.session,
                sequence: 1,
                invocation: invocation("good"),
                optimistic: true,
            });
            const reopened = yield* makeOwnedBackend(f.options);
            const resumed = yield* reopened.protocol.openClient(f.session.client);
            expect(resumed.client).toEqual(f.session.client);
            expect(resumed.acceptedThrough).toBe(1);
            expect((yield* Effect.result(f.source.read(f.session)))._tag).toBe("Failure");
            yield* reopened.protocol.submit({
                session: resumed,
                sequence: 1,
                invocation: invocation("good"),
                optimistic: true,
            });
            expect((yield* reopened.protocol.read(resumed)).state.objects[0]?.base[0]?.value.count).toBe(1);
        })
    );
});

test("owned result acknowledgments stay bounded and advance visible state coherently", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup({ maxUnacknowledged: 1 });
            let revision = 0;
            for (let sequence = 1; sequence <= 50; sequence++) {
                const delivered = yield* f.source.submit({
                    session: f.session,
                    sequence,
                    invocation: invocation(`action-${sequence}`),
                    optimistic: true,
                });
                expect(delivered.state.revision).toBeGreaterThan(revision);
                expect(delivered.state.completed).toHaveLength(1);
                yield* f.source.acknowledge(
                    f.session,
                    delivered.state.revision,
                    delivered.client.deliveredThrough
                );
                const compacted = yield* f.source.read(f.session);
                expect(compacted.state.completed).toEqual([]);
                expect(compacted.state.revision).toBeGreaterThan(delivered.state.revision);
                expect(compacted.state.objects[0]?.base[0]?.value.count).toBe(sequence);
                expect((yield* f.source.read(f.session)).state.revision).toBe(compacted.state.revision);
                revision = compacted.state.revision;
            }
            expect(
                (yield* Effect.result(
                    f.source.submit({
                        session: f.session,
                        sequence: 1,
                        invocation: invocation("action-1"),
                        optimistic: true,
                    })
                ))._tag
            ).toBe("Failure");
            expect((yield* f.source.read(f.session)).client.acceptedThrough).toBe(50);
        })
    );
});

test("expiry releases abandoned owned results while committed data survives", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup({ leaseMs: 100, maxClients: 1 });
            yield* f.source.submit({
                session: f.session,
                sequence: 1,
                invocation: invocation("one"),
                optimistic: true,
            });
            yield* TestClock.adjust(101);
            expect(yield* f.backend.collectClientGarbage).toBe(1);
            const fresh = yield* f.source.openClient();
            const state = yield* f.source.read(fresh);
            expect(state.state.completed).toEqual([]);
            expect(state.state.objects[0]?.base[0]?.value.count).toBe(1);
            expect((yield* Effect.result(f.source.openClient(f.session.client)))._tag).toBe("Failure");
            expect(
                (yield* Effect.result(
                    f.source.submit({
                        session: f.session,
                        sequence: 1,
                        invocation: invocation("one"),
                        optimistic: true,
                    })
                ))._tag
            ).toBe("Failure");
        }).pipe(Effect.provide(TestClock.layer()))
    );
});

test("one client's acknowledgment never removes another client's undelivered result", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup();
            const second = yield* f.source.openClient();
            yield* f.source.submit({
                session: f.session,
                sequence: 1,
                invocation: invocation("one"),
                optimistic: true,
            });
            const delivered = yield* f.source.submit({
                session: second,
                sequence: 1,
                invocation: invocation("two"),
                optimistic: false,
            });
            yield* f.source.acknowledge(second, delivered.state.revision, 1);
            const state = yield* f.source.read(f.session);
            expect(state.state.completed.map((entry) => entry.invocation.id)).toEqual(["one"]);
            expect(state.state.objects[0]?.base[0]?.value.count).toBe(2);
        })
    );
});

test("result and journal retention are independent of committed application rows", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const fixture = yield* setup();
            const backend = yield* makeOwnedBackend({
                ...fixture.options,
                resultRetentionMs: 100,
                history: { maxCommits: Infinity, maxAgeMs: 50 },
            });
            const before = yield* backend.loadSubset({ objectType: "Counter" });
            yield* backend.applyAction(invocation("one"));
            yield* backend.applyAction(invocation("one"));
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(1);
            yield* TestClock.adjust(101);
            yield* backend.maintenance!;
            expect(
                yield* fixture.tables.loadSubset(
                    Table.make({ name: JSON.stringify(["backend", "owned-protocol", "receipts"]) })
                )
            ).toEqual([]);
            expect(yield* Effect.result(backend.changes!.pull({ cursor: before.cursor }))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "HistoryExpired" },
            });
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(1);
            // Finite idempotency is explicit: after retention the same ID is a new invocation.
            yield* backend.applyAction(invocation("one"));
            expect((yield* backend.loadSubset({ objectType: "Counter" })).rows[0]?.value.count).toBe(2);
        }).pipe(Effect.provide(TestClock.layer()))
    );
});
