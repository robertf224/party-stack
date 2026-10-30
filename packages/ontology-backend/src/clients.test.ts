import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { clientRegistry } from "./clients.js";
import type { ClientPolicy } from "./clients.js";

const setup = Effect.fnUntraced(function* (policy?: ClientPolicy) {
    const tables = yield* Memory.make();
    const registry = clientRegistry("test", "source", policy);
    yield* tables.transaction(registry.initialize);
    const state = Table.make<{ count: number }>({ name: "application" });
    const session = yield* tables.transaction((tx) => registry.open(tx));
    const admit = (sequence: number, fingerprint = `action-${sequence}`, fail = false) =>
        tables.transaction((tx) =>
            registry.admit(tx, session, sequence, fingerprint, () =>
                Effect.gen(function* () {
                    const prior = yield* tx.get(state, "one");
                    yield* tx.put(state, "one", { count: (prior?.count ?? 0) + 1 });
                    if (fail) return yield* Effect.fail("action failed");
                })
            )
        );
    return { tables, registry, state, session, admit };
});

test("ordered admission and the client watermark commit atomically with application work", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                expect((yield* Effect.result(f.admit(1, "action-1", true)))._tag).toBe("Failure");
                expect(yield* f.tables.get(f.state, "one")).toBeUndefined();
                expect(
                    (yield* f.tables.get(f.registry.clients, f.session.client.clientId))?.acceptedThrough
                ).toBe(0);
                yield* f.admit(1);
                yield* f.admit(1);
                expect((yield* Effect.result(f.admit(1, "different payload")))._tag).toBe("Failure");
                expect((yield* Effect.result(f.admit(3)))._tag).toBe("Failure");
                yield* f.admit(2);
                expect((yield* f.tables.get(f.state, "one"))?.count).toBe(2);
                expect(
                    (yield* f.tables.get(f.registry.clients, f.session.client.clientId))?.acceptedThrough
                ).toBe(2);
            })
        )
    );
});

test("acknowledgment compacts details while the watermark prevents old execution", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup({ maxUnacknowledged: 2 });
                for (let sequence = 1; sequence <= 50; sequence++) {
                    yield* f.admit(sequence);
                    yield* f.tables.transaction((tx) => f.registry.deliver(tx, f.session, sequence));
                    yield* f.tables.transaction((tx) =>
                        f.registry.acknowledge(tx, f.session, sequence, sequence)
                    );
                    expect(yield* f.tables.query(f.registry.submissions)).toEqual([]);
                }
                expect((yield* Effect.result(f.admit(1)))._tag).toBe("Failure");
                expect((yield* f.tables.get(f.state, "one"))?.count).toBe(50);
                expect((yield* f.tables.query(f.registry.clients)).length).toBe(1);
            })
        )
    );
});

test("resume keeps ordering and fences old connections", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup();
                yield* f.admit(1);
                const reopened = clientRegistry("test", "source");
                const resumed = yield* f.tables.transaction((tx) => reopened.open(tx, f.session.client));
                expect(resumed.client).toEqual(f.session.client);
                expect(resumed.acceptedThrough).toBe(1);
                expect(resumed.connectionId).not.toBe(f.session.connectionId);
                expect((yield* Effect.result(f.admit(2)))._tag).toBe("Failure");
                yield* f.tables.transaction((tx) =>
                    reopened.admit(tx, resumed, 2, "next", () => tx.put(f.state, "one", { count: 2 }))
                );
                expect((yield* f.tables.get(f.state, "one"))?.count).toBe(2);
            })
        )
    );
});

test("expired clients and their details are bounded without deleting accepted application state", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup({ leaseMs: 100, maxClients: 1 });
                yield* f.admit(1);
                expect((yield* Effect.result(f.tables.transaction((tx) => f.registry.open(tx))))._tag).toBe(
                    "Failure"
                );
                yield* TestClock.adjust(101);
                const fresh = yield* f.tables.transaction((tx) => f.registry.open(tx));
                expect(fresh.client.clientId).not.toBe(f.session.client.clientId);
                expect((yield* f.tables.query(f.registry.clients)).length).toBe(1);
                expect(yield* f.tables.query(f.registry.submissions)).toEqual([]);
                expect((yield* f.tables.get(f.state, "one"))?.count).toBe(1);
                expect(
                    (yield* Effect.result(
                        f.tables.transaction((tx) => f.registry.open(tx, f.session.client))
                    ))._tag
                ).toBe("Failure");
                expect((yield* Effect.result(f.admit(1)))._tag).toBe("Failure");
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("future and stale acknowledgments cannot prune undelivered actions", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* setup({ maxUnacknowledged: 1 });
                yield* f.admit(1);
                expect((yield* Effect.result(f.admit(2)))._tag).toBe("Failure");
                expect(
                    (yield* Effect.result(
                        f.tables.transaction((tx) => f.registry.acknowledge(tx, f.session, 1, 1))
                    ))._tag
                ).toBe("Failure");
                yield* f.tables.transaction((tx) => f.registry.deliver(tx, f.session, 2));
                yield* f.tables.transaction((tx) => f.registry.acknowledge(tx, f.session, 1, 1));
                expect((yield* f.tables.query(f.registry.submissions)).length).toBe(1);
                yield* f.tables.transaction((tx) => f.registry.acknowledge(tx, f.session, 2, 1));
                yield* f.admit(2);
                expect((yield* f.tables.get(f.state, "one"))?.count).toBe(2);
            })
        )
    );
});

test("view generations fence reordered membership and acknowledgments even at the same source revision", async () => {
    await Effect.runPromise(
        Effect.gen(function* () {
            const f = yield* setup();
            yield* f.admit(1);
            const first = { generation: 1, selection: { subsets: [], actionIds: ["one"] } };
            const next = { generation: 2, selection: { subsets: [], actionIds: ["one", "two"] } };
            yield* f.tables.transaction((tx) => f.registry.select(tx, f.session, first));
            yield* f.tables.transaction((tx) => f.registry.deliver(tx, f.session, 10));
            yield* f.tables.transaction((tx) => f.registry.select(tx, f.session, next));
            // The previous delivery cannot certify membership in the new view.
            expect(
                (yield* Effect.result(
                    f.tables.transaction((tx) => f.registry.acknowledge(tx, f.session, 10, 1, 2))
                ))._tag
            ).toBe("Failure");
            yield* f.tables.transaction((tx) => f.registry.deliver(tx, f.session, 10));
            expect(
                (yield* Effect.result(
                    f.tables.transaction((tx) => f.registry.acknowledge(tx, f.session, 10, 1, 1))
                ))._tag
            ).toBe("Failure");
            expect(yield* f.tables.query(f.registry.submissions)).toHaveLength(1);
            expect(
                (yield* Effect.result(f.tables.transaction((tx) => f.registry.select(tx, f.session, first))))
                    ._tag
            ).toBe("Failure");
            expect(
                (yield* Effect.result(
                    f.tables.transaction((tx) =>
                        f.registry.select(tx, f.session, { ...next, selection: first.selection })
                    )
                ))._tag
            ).toBe("Failure");
            yield* f.tables.transaction((tx) => f.registry.acknowledge(tx, f.session, 10, 1, 2));
            expect(yield* f.tables.query(f.registry.submissions)).toEqual([]);
        })
    );
});
