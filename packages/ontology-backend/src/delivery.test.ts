import { it } from "@effect/vitest";
import { eq, gte, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Schema, Effect, PubSub, Queue, Stream, Scope, Exit, Fiber, Clock } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { clientRegistry } from "./clients.js";
import {
    acknowledgeDelivery,
    makeDeliveryManager,
    makeDeliveryReceiver,
    scanDeliveryRows,
    type DeliveryFrame,
    type DeliveryRecord,
} from "./delivery.js";
import { BackendError, classifyBackendFailure } from "./index.js";
import type { Transaction } from "@party-stack/ontology-storage/tables";

const operation = Schema.Struct({
    key: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
    value: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
    remove: Schema.Boolean,
});

it.live.prop(
    "incremental delivery agrees with an independent full-snapshot oracle after every write",
    [
        Schema.Array(operation).check(Schema.isMaxLength(35)),
        Schema.Struct({
            minimum: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
            limit: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
            offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
            descending: Schema.Boolean,
        }),
    ],
    ([operations, selection]) =>
        Effect.gen(function* () {
            yield* Effect.scoped(
                Effect.gen(function* () {
                    const tables = yield* Memory.make();
                    const deliveries = yield* makeDeliveryManager({ tables, namespace: "oracle" });
                    const rows = Table.make<{ id: number; value: number }>({ name: "rows" });
                    const events = yield* PubSub.sliding<void>(1);
                    const complete = yield* Queue.unbounded<DeliveryFrame>();
                    let revision = 1;
                    const subscription = yield* deliveries.open({
                        binding: "test",
                        identity: "selection",
                        policy: { frameRecords: 2, frameBytes: 2048 },
                        changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                        capture: (tx, emit) =>
                            Effect.gen(function* () {
                                yield* scanDeliveryRows(
                                    tx,
                                    rows,
                                    {
                                        where: gte(field("id"), selection.minimum),
                                        orderBy: [
                                            {
                                                field: field("value"),
                                                direction: selection.descending ? "desc" : "asc",
                                            },
                                            { field: field("id") },
                                        ],
                                        limit: selection.limit,
                                        offset: selection.offset,
                                    },
                                    (row) => emit({ kind: "base", objectType: "Row", ...row })
                                );
                                const overlap = yield* tx.get(rows, 0);
                                if (overlap)
                                    yield* emit({ kind: "base", objectType: "Row", key: 0, value: overlap });
                                return {
                                    sourceId: "authority",
                                    schemaHash: "schema",
                                    revision,
                                    generation: 1,
                                    coverage: [],
                                };
                            }).pipe(Effect.orDie),
                    });
                    const installedRows = Table.make<{ id: number; value: number }>({ name: "installed" });
                    const receiver = yield* makeDeliveryReceiver({
                        tables,
                        namespace: "child",
                        apply: (tx, batch) =>
                            Effect.gen(function* () {
                                if (batch.kind === "snapshot")
                                    yield* tx.clear(installedRows).pipe(Effect.orDie);
                                yield* batch.forEach((change) =>
                                    Effect.gen(function* () {
                                        if (change.kind === "put" && change.record.kind === "base")
                                            yield* tx
                                                .put(
                                                    installedRows,
                                                    change.record.key,
                                                    change.record.value as { id: number; value: number }
                                                )
                                                .pipe(Effect.orDie);
                                        if (change.kind === "remove" && "key" in change.ref)
                                            yield* tx
                                                .delete(installedRows, change.ref.key)
                                                .pipe(Effect.orDie);
                                    })
                                );
                            }),
                    });
                    const oracle = new Map<number, number>();
                    yield* Stream.runForEach(subscription.frames, (frame) =>
                        Effect.gen(function* () {
                            yield* receiver.receive(frame);
                            if (frame.end) yield* Queue.offer(complete, frame);
                        })
                    ).pipe(Effect.forkScoped);
                    const first = yield* Queue.take(complete);
                    yield* subscription.acknowledge(first);
                    for (const op of operations) {
                        if (op.remove) {
                            yield* tables.delete(rows, op.key);
                            oracle.delete(op.key);
                        } else {
                            yield* tables.put(rows, op.key, { id: op.key, value: op.value });
                            oracle.set(op.key, op.value);
                        }
                        revision++;
                        yield* PubSub.publish(events, undefined);
                        const batch = yield* Queue.take(complete).pipe(Effect.timeout("2 seconds"));
                        const selected = [...oracle]
                            .filter(([key]) => key >= selection.minimum)
                            .sort(([a, av], [b, bv]) => (selection.descending ? bv - av : av - bv) || a - b)
                            .slice(selection.offset, selection.offset + selection.limit);
                        const expected = new Map(selected);
                        if (oracle.has(0)) expected.set(0, oracle.get(0)!);
                        expect(
                            (yield* tables.query(installedRows))
                                .map((row) => [row.key, row.value.value])
                                .sort(([a], [b]) => Number(a) - Number(b))
                        ).toEqual([...expected].sort(([a], [b]) => a - b));
                        yield* subscription.acknowledge(batch);
                    }
                })
            );
        }),
    { arbitrary: { runs: 60 } }
);

test("a slow consumer holds one batch and coalesces intervening writes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "slow" });
                const events = yield* PubSub.sliding<void>(1);
                const batches = yield* Queue.unbounded<DeliveryFrame>();
                let revision = 1;
                let captures = 0;
                let value = 0;
                const subscription = yield* deliveries.open({
                    binding: "test",
                    identity: "selection",
                    changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                    capture: (_tx, emit) =>
                        Effect.gen(function* () {
                            captures++;
                            yield* emit({
                                kind: "base",
                                objectType: "Row",
                                key: "one",
                                value: { id: "one", value },
                            });
                            return {
                                sourceId: "source",
                                schemaHash: "schema",
                                generation: 1,
                                revision,
                                coverage: [],
                            };
                        }),
                });
                const puts: number[] = [];
                yield* Stream.runForEach(subscription.frames, (frame) =>
                    Effect.gen(function* () {
                        for (const change of frame.changes)
                            if (change.kind === "put" && change.record.kind === "base")
                                puts.push(change.record.value.value as number);
                        if (frame.end) yield* Queue.offer(batches, frame);
                    })
                ).pipe(Effect.forkScoped);
                const first = yield* Queue.take(batches);
                for (let n = 1; n <= 20; n++) {
                    value = n;
                    revision++;
                    yield* PubSub.publish(events, undefined);
                }
                yield* Effect.yieldNow;
                expect(captures).toBe(1);
                yield* subscription.acknowledge(first);
                const second = yield* Queue.take(batches).pipe(Effect.timeout("2 seconds"));
                expect(captures).toBe(2);
                expect(puts).toEqual([0, 20]);
                yield* subscription.acknowledge(second);
            })
        )
    );
});

const metadata = { sourceId: "source", schemaHash: "schema", generation: 1, revision: 1, coverage: [] };

it.effect("quiet heartbeats renew leases without capturing and notified changes deliver immediately", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const namespace = "quiet-bootstrap";
            const deliveries = yield* makeDeliveryManager({ tables, namespace });
            const ends = yield* Queue.unbounded<DeliveryFrame>();
            const events = yield* PubSub.sliding<void>(1);
            const renewed = yield* Queue.unbounded<void>();
            let captures = 0;
            let revision = 1;
            const heartbeatMs = 1_000;
            const subscription = yield* deliveries.open({
                binding: "caller",
                identity: "selected",
                policy: { heartbeatMs },
                changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                renew: () => Queue.offer(renewed, undefined).pipe(Effect.asVoid),
                capture: () =>
                    Effect.sync(() => {
                        captures++;
                        return { ...metadata, revision };
                    }),
            });
            yield* Stream.runForEach(subscription.frames, (frame) =>
                frame.end ? Queue.offer(ends, frame) : Effect.void
            ).pipe(Effect.forkScoped);
            const first = yield* Queue.take(ends);
            yield* subscription.acknowledge(first);
            const sessions = Table.make<{ installed: number; expiresAt: number }>({
                name: JSON.stringify([namespace, "delivery", "sessions"]),
            });
            while ((yield* tables.get(sessions, first.streamId))?.installed !== first.sequence)
                yield* Effect.yieldNow;
            yield* TestClock.adjust(heartbeatMs - 1);
            expect(captures).toBe(1);
            yield* TestClock.adjust(1);
            yield* Queue.take(renewed);
            expect(captures).toBe(1);
            // A heartbeat is not a source poll. Missed notifications are repaired
            // by reconnect capture, not by pretending a lease renewal read data.
            revision++;
            yield* TestClock.adjust(heartbeatMs);
            yield* Queue.take(renewed);
            expect(captures).toBe(1);
            yield* Effect.sleep(heartbeatMs).pipe(
                Effect.andThen(PubSub.publish(events, undefined)),
                Effect.forkScoped
            );
            // A hint racing the renewal timer must still trigger its capture.
            yield* TestClock.adjust(heartbeatMs);
            const changed = yield* Queue.take(ends);
            expect(changed.metadata?.revision).toBe(revision);
            expect(captures).toBe(2);
            yield* subscription.acknowledge(changed);
            while ((yield* tables.get(sessions, changed.streamId))?.installed !== changed.sequence)
                yield* Effect.yieldNow;
            // The no-change branch also waits through quiet renewals rather
            // than capturing on each timer or spinning after a redundant hint.
            yield* PubSub.publish(events, undefined);
            while (captures !== 3) yield* Effect.yieldNow;
            yield* TestClock.adjust(heartbeatMs);
            yield* Queue.take(renewed);
            expect(captures).toBe(3);
        })
    )
);

it.effect("quiet renewal checks durable producer fencing without capturing selected rows", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const namespace = "quiet-fence";
            const deliveries = yield* makeDeliveryManager({ tables, namespace });
            const ends = yield* Queue.unbounded<DeliveryFrame>();
            const sessions = Table.make<Record<string, unknown>>({
                name: JSON.stringify([namespace, "delivery", "sessions"]),
            });
            let captures = 0;
            const subscription = yield* deliveries.open({
                binding: "caller",
                identity: "selected",
                policy: { heartbeatMs: 100 },
                changes: Effect.succeed(Stream.never),
                capture: () =>
                    Effect.sync(() => {
                        captures++;
                        return metadata;
                    }),
            });
            const running = yield* Stream.runForEach(subscription.frames, (frame) =>
                frame.end ? Queue.offer(ends, frame) : Effect.void
            ).pipe(Effect.forkScoped);
            const first = yield* Queue.take(ends);
            yield* subscription.acknowledge(first);
            while ((yield* tables.get(sessions, first.streamId))?.installed !== first.sequence)
                yield* Effect.yieldNow;
            const header = (yield* tables.get(sessions, first.streamId))!;
            yield* tables.put(sessions, first.streamId, { ...header, producer: "replacement" });
            yield* TestClock.adjust(100);
            expect(yield* Effect.result(Fiber.join(running))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "SessionReplaced" },
            });
            expect(captures).toBe(1);
        })
    )
);

it.effect("reconnect captures changes missed while the acknowledged producer was disconnected", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const namespace = "quiet-reconnect";
            const deliveries = yield* makeDeliveryManager({ tables, namespace });
            const scope = yield* Scope.make();
            const ends = yield* Queue.unbounded<DeliveryFrame>();
            let revision = 1;
            let captures = 0;
            const config = {
                binding: "caller",
                identity: "selected",
                changes: Effect.succeed(Stream.never),
                capture: () =>
                    Effect.sync(() => {
                        captures++;
                        return { ...metadata, revision };
                    }),
            };
            const initial = yield* deliveries.open(config).pipe(Scope.provide(scope));
            yield* Stream.runForEach(initial.frames, (frame) =>
                frame.end ? Queue.offer(ends, frame) : Effect.void
            ).pipe(Effect.forkIn(scope));
            const first = yield* Queue.take(ends);
            yield* initial.acknowledge(first);
            const sessions = Table.make<{ installed: number }>({
                name: JSON.stringify([namespace, "delivery", "sessions"]),
            });
            while ((yield* tables.get(sessions, first.streamId))?.installed !== first.sequence)
                yield* Effect.yieldNow;
            yield* Scope.close(scope, Exit.void);
            revision = 2;
            const resumed = yield* deliveries.open({
                ...config,
                resume: { streamId: first.streamId, sequence: first.sequence },
            });
            const frames = yield* resumed.frames.pipe(
                Stream.takeUntil((frame) => frame.end),
                Stream.runCollect
            );
            expect(frames.at(-1)).toMatchObject({
                streamId: first.streamId,
                sequence: first.sequence + 1,
                kind: "patch",
                metadata: { revision: 2 },
            });
            expect(captures).toBe(2);
            yield* resumed.acknowledge(frames.at(-1)!);
        })
    )
);

it.effect("heartbeats renew the associated client lease without advancing delivered state", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const namespace = "quiet-client";
            const clients = clientRegistry(namespace, "source", { sessionIdleTimeoutMs: 120 });
            const session = yield* tables.transaction((tx) =>
                clients.initialize(tx).pipe(Effect.andThen(clients.open(tx)))
            );
            const selected = { generation: 1, selection: { subsets: [], actionIds: [] } };
            const deliveries = yield* makeDeliveryManager({ tables, namespace });
            const ends = yield* Queue.unbounded<DeliveryFrame>();
            const renewed = yield* Queue.unbounded<void>();
            const scope = yield* Scope.make();
            let captures = 0;
            const subscription = yield* deliveries
                .open({
                    binding: "caller",
                    identity: "selected",
                    policy: { heartbeatMs: 50 },
                    changes: Effect.succeed(Stream.never),
                    capture: (tx) =>
                        Effect.gen(function* () {
                            captures++;
                            yield* clients.select(tx, session, selected);
                            return { ...metadata, client: yield* clients.deliver(tx, session, 1) };
                        }).pipe(Effect.mapError((cause) => classifyBackendFailure("test.capture", cause))),
                    renew: (tx) =>
                        clients.select(tx, session, selected).pipe(
                            Effect.andThen(Queue.offer(renewed, undefined)),
                            Effect.asVoid,
                            Effect.mapError((cause) => classifyBackendFailure("test.renew", cause))
                        ),
                })
                .pipe(Scope.provide(scope));
            yield* Stream.runForEach(subscription.frames, (frame) =>
                frame.end ? Queue.offer(ends, frame) : Effect.void
            ).pipe(Effect.forkIn(scope));
            yield* subscription.acknowledge(yield* Queue.take(ends));
            for (let n = 0; n < 5; n++) {
                yield* TestClock.adjust(50);
                yield* Queue.take(renewed);
                expect(yield* tables.transaction((tx) => clients.expire(tx))).toEqual([]);
                const current = yield* tables.get(clients.clients, session.client.clientId);
                expect(current?.deliveredRevision).toBe(1);
                expect(current?.deliveredThrough).toBe(0);
                expect(captures).toBe(1);
            }
            yield* Scope.close(scope, Exit.void);
            yield* TestClock.adjust(121);
            expect(yield* tables.transaction((tx) => clients.expire(tx))).toEqual([session.client.clientId]);
        })
    )
);

it.effect("unacknowledged data still expires on its ACK deadline without heartbeat captures", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const deliveries = yield* makeDeliveryManager({ tables, namespace: "quiet-ack-deadline" });
            const ends = yield* Queue.unbounded<DeliveryFrame>();
            let captures = 0;
            const subscription = yield* deliveries.open({
                binding: "caller",
                identity: "selected",
                policy: { heartbeatMs: 25, ackTimeoutMs: 100 },
                changes: Effect.succeed(Stream.never),
                capture: () =>
                    Effect.sync(() => {
                        captures++;
                        return metadata;
                    }),
            });
            const running = yield* Stream.runForEach(subscription.frames, (frame) =>
                frame.end ? Queue.offer(ends, frame) : Effect.void
            ).pipe(Effect.forkScoped);
            yield* Queue.take(ends);
            yield* TestClock.adjust(100);
            expect(yield* Effect.result(Fiber.join(running))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "Unavailable", message: "Delivery acknowledgment timed out." },
            });
            expect(captures).toBe(1);
        })
    )
);

const firstFrame: DeliveryFrame = {
    streamId: "atomic",
    sequence: 1,
    previous: 0,
    part: 0,
    kind: "snapshot",
    end: false,
    changes: [{ kind: "put", record: { kind: "base", objectType: "Row", key: "new", value: { id: "new" } } }],
};
const finalFrame: DeliveryFrame = { ...firstFrame, part: 1, changes: [], end: true, metadata };

test("installation is atomic, receipt evidence survives a failed apply, and replay is idempotent", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const rows = Table.make<Record<string, unknown>>({ name: "atomic-rows" });
                const evidence = Table.make<boolean>({ name: "evidence" });
                yield* tables.put(rows, "old", { id: "old" });
                let fail = true;
                let applies = 0;
                const receiver = yield* makeDeliveryReceiver({
                    tables,
                    namespace: "atomic",
                    beforeApply: (tx) => tx.put(evidence, "receipt", true).pipe(Effect.orDie),
                    apply: (tx, batch) =>
                        Effect.gen(function* () {
                            yield* tx.clear(rows).pipe(Effect.orDie);
                            yield* batch.forEach((change) =>
                                change.kind === "put" && change.record.kind === "base"
                                    ? tx.put(rows, change.record.key, change.record.value).pipe(Effect.orDie)
                                    : Effect.void
                            );
                            if (fail)
                                return yield* new BackendError({
                                    operation: "test",
                                    kind: "Unavailable",
                                    retryable: true,
                                    message: "alias unavailable",
                                });
                            applies++;
                        }),
                });
                yield* receiver.receive(firstFrame);
                expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["old"]);
                yield* receiver.receive(firstFrame); // identical frame retransmission
                expect((yield* Effect.result(receiver.receive(finalFrame)))._tag).toBe("Failure");
                expect(yield* tables.get(evidence, "receipt")).toBe(true);
                expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["old"]);
                expect(yield* receiver.installed).toBeUndefined();
                fail = false;
                yield* receiver.receive(finalFrame);
                expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["new"]);
                yield* receiver.receive(firstFrame);
                expect((yield* receiver.receive(finalFrame))?.duplicate).toBe(true);
                expect(applies).toBe(1);
                expect((yield* Effect.result(receiver.receive({ ...firstFrame, changes: [] })))._tag).toBe(
                    "Success"
                );
                expect((yield* Effect.result(receiver.receive(finalFrame)))._tag).toBe("Failure");
            })
        )
    );
});

test("gaps, invalid frame order and exceeded budgets never install partial data", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let applies = 0;
                const receiver = yield* makeDeliveryReceiver({
                    tables,
                    namespace: "gaps",
                    maxRecords: 1,
                    apply: () =>
                        Effect.sync(() => {
                            applies++;
                        }),
                });
                expect((yield* Effect.result(receiver.receive(finalFrame)))._tag).toBe("Failure");
                yield* receiver.receive(firstFrame);
                expect((yield* Effect.result(receiver.receive({ ...firstFrame, part: 2 })))._tag).toBe(
                    "Failure"
                );
                expect((yield* Effect.result(receiver.receive({ ...firstFrame, part: 1 })))._tag).toBe(
                    "Failure"
                );
                yield* receiver.receive(finalFrame);
                expect(applies).toBe(1);
                expect(
                    (yield* Effect.result(
                        receiver.receive({ ...firstFrame, sequence: 3, previous: 2, kind: "patch" })
                    ))._tag
                ).toBe("Failure");
                expect(applies).toBe(1);
            })
        )
    );
});

test("frame buffers retain a valid prefix after rejected data without staging individual row records", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const namespace = "buffered-staging";
                const staging = Table.make({
                    name: JSON.stringify([namespace, "incoming-delivery", "changes"]),
                });
                const hashes = Table.make({
                    name: JSON.stringify([namespace, "incoming-delivery", "frames"]),
                });
                const state = Table.make({ name: JSON.stringify([namespace, "incoming-delivery", "state"]) });
                const application = Table.make<Record<string, unknown>>({ name: "buffered-application" });
                let stagingWrites = 0;
                const instrumented: typeof tables = {
                    ...tables,
                    transaction: (body) =>
                        tables.transaction((tx) =>
                            body({
                                ...tx,
                                put: (table, key, value) => {
                                    if (table.name === staging.name || table.name === hashes.name)
                                        stagingWrites++;
                                    return tx.put(table, key, value);
                                },
                                putMany: (table, rows) => {
                                    if (table.name === staging.name || table.name === hashes.name)
                                        stagingWrites += rows.length;
                                    return tx.putMany(table, rows);
                                },
                            })
                        ),
                };
                const receiver = yield* makeDeliveryReceiver({
                    tables: instrumented,
                    namespace,
                    apply: (tx, batch) =>
                        batch.forEach((change) => {
                            if (change.kind === "put" && change.record.kind === "base")
                                return tx
                                    .put(application, change.record.key, change.record.value)
                                    .pipe(Effect.orDie);
                            if (change.kind === "remove" && change.ref.kind === "base")
                                return tx.delete(application, change.ref.key).pipe(Effect.orDie);
                            return Effect.void;
                        }),
                });
                const positions = Array.from({ length: 128 }, (_, key) => key);
                const first: DeliveryFrame = {
                    streamId: "buffered-stream",
                    sequence: 1,
                    previous: 0,
                    part: 0,
                    kind: "snapshot",
                    end: false,
                    changes: positions.map((key) => ({
                        kind: "put",
                        record: { kind: "base", objectType: "Row", key, value: { id: key, n: key } },
                    })),
                };
                yield* receiver.receive(first);
                expect(yield* tables.query(application)).toEqual([]);
                expect(yield* tables.query(staging)).toEqual([]);
                expect(yield* tables.query(hashes)).toEqual([]);
                expect(yield* tables.get(state, "pending")).toBeUndefined();
                yield* receiver.receive(first);
                expect(
                    yield* Effect.result(receiver.receive({ ...first, changes: first.changes.slice(0, 1) }))
                ).toMatchObject({ _tag: "Failure", failure: { kind: "Conflict" } });
                const circular: Record<string, unknown> = {};
                circular.loop = circular;
                expect(
                    yield* Effect.result(
                        receiver.receive({
                            ...first,
                            part: 1,
                            changes: [
                                {
                                    kind: "put",
                                    record: { kind: "base", objectType: "Row", key: 3, value: circular },
                                },
                            ],
                        })
                    )
                ).toMatchObject({ _tag: "Failure", failure: { kind: "InvalidResponse" } });
                yield* receiver.receive({
                    ...first,
                    part: 1,
                    changes: [
                        { kind: "remove", ref: { kind: "base", objectType: "Row", key: 3 } },
                        {
                            kind: "put",
                            record: { kind: "base", objectType: "Row", key: 3, value: { id: 3, n: 999 } },
                        },
                    ],
                });
                expect(yield* tables.query(application)).toEqual([]);
                yield* receiver.receive({ ...first, part: 2, changes: [], end: true, metadata });
                expect((yield* tables.query(application)).map((row) => row.value)).toEqual(
                    positions.map((key) => ({ id: key, n: key === 3 ? 999 : key }))
                );
                expect(stagingWrites).toBe(0);
            })
        )
    );
});

test("acknowledgments from another handler use stored positions; producer scope cleanup retains resumable owner buffers", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "http" });
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const events = yield* PubSub.sliding<void>(1);
                        const ends = yield* Queue.unbounded<DeliveryFrame>();
                        let revision = 1;
                        const subscription = yield* deliveries.open({
                            binding: "test",
                            identity: "selection",
                            changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                            capture: () => Effect.succeed({ ...metadata, revision }),
                        });
                        yield* Stream.runForEach(subscription.frames, (frame) =>
                            frame.end ? Queue.offer(ends, frame) : Effect.void
                        ).pipe(Effect.forkScoped);
                        const first = yield* Queue.take(ends);
                        yield* acknowledgeDelivery(tables, "http", first);
                        revision++;
                        yield* PubSub.publish(events, undefined);
                        const second = yield* Queue.take(ends).pipe(Effect.timeout("2 seconds"));
                        expect(second.previous).toBe(first.sequence);
                        expect(second.kind).toBe("patch");
                        yield* acknowledgeDelivery(tables, "http", first); // old duplicates must not acknowledge the newer batch
                        expect(
                            (yield* Effect.result(
                                acknowledgeDelivery(tables, "http", {
                                    ...second,
                                    sequence: second.sequence + 1,
                                })
                            ))._tag
                        ).toBe("Failure");
                        yield* acknowledgeDelivery(tables, "http", second);
                    })
                );
                const sessions = Table.make({ name: JSON.stringify(["http", "delivery", "sessions"]) });
                const records = Table.make({ name: JSON.stringify(["http", "delivery", "records"]) });
                expect(yield* tables.query(sessions, { where: eq(field("expected"), 2) })).toHaveLength(1);
                expect(yield* tables.query(records)).toEqual([]);
            })
        )
    );
});

test("owner buffers resume after producer/receiver recreation and lost acknowledgments without reapplying", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "resume" });
                const local = yield* Memory.make();
                const rows = Table.make<{ value: number }>({ name: "local" });
                const events = yield* PubSub.sliding<void>(1);
                let value = 1;
                let applies = 0;
                const receiver = () =>
                    makeDeliveryReceiver({
                        tables: local,
                        namespace: "child",
                        apply: (tx, batch) =>
                            Effect.gen(function* () {
                                applies++;
                                yield* batch.forEach((change) =>
                                    change.kind === "put" && change.record.kind === "base"
                                        ? tx
                                              .put(
                                                  rows,
                                                  change.record.key,
                                                  change.record.value as { value: number }
                                              )
                                              .pipe(Effect.orDie)
                                        : Effect.void
                                );
                            }),
                    });
                const firstReceiver = yield* receiver();
                const firstScope = yield* Scope.make();
                const first = yield* Scope.provide(
                    deliveries.open({
                        binding: "authority",
                        identity: "selected",
                        changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                        capture: (_tx, emit) =>
                            emit({ kind: "base", objectType: "Item", key: "one", value: { value } }).pipe(
                                Effect.as({ ...metadata, revision: value })
                            ),
                    }),
                    firstScope
                );
                const received = yield* Queue.unbounded<DeliveryFrame>();
                yield* Scope.provide(
                    Stream.runForEach(first.frames, (frame) =>
                        firstReceiver
                            .receive(frame)
                            .pipe(Effect.andThen(frame.end ? Queue.offer(received, frame) : Effect.void))
                    ).pipe(Effect.forkScoped),
                    firstScope
                );
                const initial = yield* Queue.take(received);
                yield* Scope.close(firstScope, Exit.void); // durable install, lost acknowledgment
                expect(applies).toBe(1);
                value = 2;
                const reopenedReceiver = yield* receiver();
                const next = yield* deliveries.open({
                    binding: "authority",
                    identity: "selected",
                    resume: yield* reopenedReceiver.resume,
                    changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                    capture: (_tx, emit) =>
                        emit({ kind: "base", objectType: "Item", key: "one", value: { value } }).pipe(
                            Effect.as({ ...metadata, revision: value })
                        ),
                });
                yield* Stream.runForEach(next.frames, (frame) =>
                    Effect.gen(function* () {
                        const installed = yield* reopenedReceiver.receive(frame);
                        if (installed) {
                            yield* next.acknowledge(installed.position);
                            yield* Queue.offer(received, frame);
                        }
                    })
                ).pipe(Effect.forkScoped);
                const duplicate = yield* Queue.take(received);
                expect(duplicate.streamId).toBe(initial.streamId);
                expect(duplicate.sequence).toBe(initial.sequence);
                const patch = yield* Queue.take(received);
                expect(patch).toMatchObject({
                    streamId: initial.streamId,
                    kind: "patch",
                    sequence: 2,
                    previous: 1,
                });
                expect(applies).toBe(2);
                expect(yield* local.get(rows, "one")).toEqual({ value: 2 });
            })
        )
    );
});

test("delivery expiry is indexed, bounded and requires a fresh snapshot after retention", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let deleting = 0;
                let concurrentDeletes = 0;
                const batched: typeof tables = {
                    ...tables,
                    transaction: (body) =>
                        tables.transaction((tx) =>
                            body({
                                ...tx,
                                delete: (table, key) =>
                                    Effect.gen(function* () {
                                        deleting++;
                                        concurrentDeletes = Math.max(concurrentDeletes, deleting);
                                        yield* Effect.yieldNow;
                                        yield* tx.delete(table, key);
                                    }).pipe(
                                        Effect.ensuring(
                                            Effect.sync(() => {
                                                deleting--;
                                            })
                                        )
                                    ),
                            })
                        ),
                };
                const scope = yield* Scope.make();
                const deliveries = yield* makeDeliveryManager({ tables: batched, namespace: "expiry" });
                const config = {
                    binding: "authority",
                    identity: "query",
                    policy: { retentionMs: 10 },
                    changes: Effect.succeed(Stream.never),
                    capture: (
                        _tx: Transaction,
                        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
                    ) =>
                        Effect.gen(function* () {
                            for (let key = 0; key < 260; key++)
                                yield* emit({ kind: "base", objectType: "Row", key, value: { id: key } });
                            return metadata;
                        }),
                };
                const first = yield* Scope.provide(deliveries.open(config), scope);
                const frames = yield* Stream.runCollect(first.frames.pipe(Stream.take(1)));
                const position = { streamId: frames[0]!.streamId, sequence: 0 };
                // Old per-record buffers may remain until their durable headers expire.
                const legacyRecords = Table.make<{ stream: string; value: number }>({
                    name: JSON.stringify(["expiry", "delivery", "records"]),
                });
                yield* tables.putMany(
                    legacyRecords,
                    Array.from({ length: 260 }, (_, key) => ({
                        key,
                        value: { stream: position.streamId, value: key },
                    }))
                );
                yield* TestClock.adjust(11);
                expect(yield* deliveries.collectGarbage).toBe(0);
                yield* Scope.close(scope, Exit.void);
                yield* TestClock.adjust(11);
                expect(yield* deliveries.collectGarbage).toBe(1);
                expect(concurrentDeletes).toBeGreaterThan(1);
                expect(concurrentDeletes).toBeLessThanOrEqual(128);
                expect(
                    yield* tables.query(
                        Table.make({ name: JSON.stringify(["expiry", "delivery", "records"]) })
                    )
                ).toEqual([]);
                expect(
                    yield* tables.query(
                        Table.make({ name: JSON.stringify(["expiry", "delivery", "patches"]) })
                    )
                ).toEqual([]);
                expect(yield* Effect.result(deliveries.open({ ...config, resume: position }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "HistoryExpired" },
                });
                const fresh = yield* deliveries.open(config);
                const snapshot = (yield* Stream.runCollect(fresh.frames.pipe(Stream.take(1))))[0]!;
                expect(snapshot.kind).toBe("snapshot");
                expect(snapshot.streamId).not.toBe(position.streamId);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

test("selection replacement releases old witnesses instead of accumulating delivery sessions", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "replace" });
                const config = {
                    binding: "authority",
                    identity: "first",
                    rowSelection: "same-rows",
                    policy: { maxSubscriptions: 1 },
                    changes: Effect.succeed(Stream.never),
                    capture: () => Effect.succeed(metadata),
                };
                const first = yield* deliveries.open(config);
                const initial = (yield* Stream.runCollect(first.frames.pipe(Stream.take(1))))[0]!;
                const second = yield* deliveries.open({
                    ...config,
                    identity: "second",
                    rowSelection: "different-rows",
                    resume: { streamId: initial.streamId, sequence: 0 },
                });
                const replacement = (yield* Stream.runCollect(second.frames.pipe(Stream.take(1))))[0]!;
                expect(replacement.kind).toBe("snapshot");
                expect(replacement.streamId).not.toBe(initial.streamId);
                const sessions = Table.make({ name: JSON.stringify(["replace", "delivery", "sessions"]) });
                expect(yield* tables.query(sessions)).toHaveLength(1);
            })
        )
    );
});

test("installed row witnesses survive interest changes, including a lost acknowledgment", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "interest-changes" });
                let generation = 1;
                const config = {
                    binding: "authority",
                    rowSelection: "same-rows",
                    changes: Effect.succeed(Stream.never),
                    capture: (
                        _tx: Transaction,
                        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
                    ) =>
                        Effect.gen(function* () {
                            for (let key = 0; key < 200; key++)
                                yield* emit({
                                    kind: "base",
                                    objectType: "Row",
                                    key,
                                    value: { id: key, value: key === 0 ? generation : 0 },
                                });
                            return { ...metadata, generation };
                        }),
                };
                const first = yield* deliveries.open({ ...config, identity: "first-interest" });
                const initial = yield* first.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                const installed = initial.at(-1)!;
                // The receiver installed the whole batch; its ACK never reached the producer.
                generation++;
                const second = yield* deliveries.open({
                    ...config,
                    identity: "second-interest",
                    resume: installed,
                });
                const patches = yield* second.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                expect(patches).toHaveLength(1);
                expect(patches[0]).toMatchObject({
                    streamId: installed.streamId,
                    previous: installed.sequence,
                    sequence: installed.sequence + 1,
                    kind: "patch",
                    metadata: { generation: 2 },
                });
                expect(patches[0]!.changes).toEqual([
                    {
                        kind: "put",
                        record: {
                            kind: "base",
                            objectType: "Row",
                            key: 0,
                            value: { id: 0, value: 2 },
                        },
                    },
                ]);
                // An uninstalled target is replayed unchanged. It does not
                // become the next diff's baseline until installation is proved.
                generation++;
                const third = yield* deliveries.open({
                    ...config,
                    identity: "third-interest",
                    resume: installed,
                });
                const reset = yield* third.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                expect(reset).toEqual(patches);
                expect(reset[0]!.streamId).toBe(installed.streamId);
            })
        )
    );
});

test("a later duplicate replaces its patch across capture pages", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "paged-duplicates" });
                const row = (key: number, value: number): DeliveryRecord => ({
                    kind: "base",
                    objectType: "Row",
                    key,
                    value: { id: key, value },
                });
                const subscription = yield* deliveries.open({
                    binding: "source",
                    identity: "all",
                    changes: Effect.succeed(Stream.never),
                    capture: (_tx, emit) =>
                        Effect.gen(function* () {
                            for (let key = 0; key < 260; key++) yield* emit(row(key, 0));
                            yield* emit(row(0, 7));
                            return metadata;
                        }),
                });
                const frames = yield* subscription.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                const changes = frames.flatMap((frame) => frame.changes);
                expect(changes).toHaveLength(260);
                expect(changes[0]).toEqual({ kind: "put", record: row(0, 7) });
                expect(changes.at(-1)).toEqual({ kind: "put", record: row(259, 0) });
                yield* subscription.acknowledge(frames.at(-1)!);
            })
        )
    );
});

test("snapshot and patch delivery perform no per-record persistent buffer IO", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let witnessWrites = 0;
                let witnessDeletes = 0;
                let witnessLookups = 0;
                const instrumented: typeof tables = {
                    ...tables,
                    transaction: (body) =>
                        tables.transaction((tx) =>
                            body({
                                ...tx,
                                get: (table, key, options) => {
                                    if (
                                        table.name.endsWith('"records"]') ||
                                        table.name.endsWith('"patches"]')
                                    )
                                        witnessLookups++;
                                    return tx.get(table, key, options);
                                },
                                put: (table, key, value) => {
                                    if (
                                        !table.name.endsWith('"records"]') &&
                                        !table.name.endsWith('"patches"]')
                                    )
                                        return tx.put(table, key, value);
                                    witnessWrites++;
                                    return tx.put(table, key, value);
                                },
                                putMany: (table, rows) => {
                                    if (
                                        table.name.endsWith('"records"]') ||
                                        table.name.endsWith('"patches"]')
                                    )
                                        witnessWrites += rows.length;
                                    return tx.putMany(table, rows);
                                },
                                delete: (table, key) => {
                                    if (
                                        table.name.endsWith('"records"]') ||
                                        table.name.endsWith('"patches"]')
                                    )
                                        witnessDeletes++;
                                    return tx.delete(table, key);
                                },
                            })
                        ),
                };
                const deliveries = yield* makeDeliveryManager({
                    tables: instrumented,
                    namespace: "write-amplification",
                });
                const values = new Map(Array.from({ length: 1434 }, (_, id) => [id, 0]));
                let revision = 1;
                const events = yield* PubSub.sliding<void>(1);
                const batches = yield* Queue.unbounded<DeliveryFrame>();
                const subscription = yield* deliveries.open({
                    binding: "source",
                    identity: "all",
                    changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
                    capture: (_tx, emit) =>
                        Effect.gen(function* () {
                            for (const [key, value] of values) {
                                const row = {
                                    kind: "base" as const,
                                    objectType: "Row",
                                    key,
                                    value: { id: key, value },
                                };
                                yield* emit(row);
                                yield* emit(row); // Overlapping subsets must not duplicate writes or patches.
                            }
                            return { ...metadata, revision };
                        }),
                });
                yield* Stream.runForEach(subscription.frames, (frame) =>
                    frame.end ? Queue.offer(batches, frame) : Effect.void
                ).pipe(Effect.forkScoped);
                const first = yield* Queue.take(batches);
                expect(witnessWrites).toBe(0);
                yield* subscription.acknowledge(first);
                witnessWrites = 0;
                revision++;
                yield* PubSub.publish(events, undefined);
                const second = yield* Queue.take(batches);
                expect(second.kind).toBe("patch");
                expect(second.changes).toEqual([]);
                expect(witnessWrites).toBe(0);
                yield* subscription.acknowledge(second);
                values.set(3, 1);
                revision++;
                yield* PubSub.publish(events, undefined);
                const third = yield* Queue.take(batches);
                expect(third.changes).toHaveLength(1);
                expect(witnessWrites).toBe(0);
                yield* subscription.acknowledge(third);
                values.delete(3);
                revision++;
                yield* PubSub.publish(events, undefined);
                const fourth = yield* Queue.take(batches);
                expect(fourth.changes).toEqual([
                    { kind: "remove", ref: { kind: "base", objectType: "Row", key: 3 } },
                ]);
                expect(witnessWrites).toBe(0);
                expect(witnessDeletes).toBe(0);
                expect(witnessLookups).toBe(0);
                yield* subscription.acknowledge(fourth);
            })
        ).pipe(Effect.timeout("10 seconds"))
    );
});

test("owner loss retires only the matching view and permits a bounded fresh snapshot", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const durableActions = Table.make<{ outcome: string }>({ name: "durable-action-outcomes" });
                yield* tables.put(durableActions, "action", { outcome: "committed" });
                const ownerScope = yield* Scope.make();
                const firstOwner = yield* Scope.provide(
                    makeDeliveryManager({ tables, namespace: "owner-loss" }),
                    ownerScope
                );
                let value = 1;
                const config = {
                    binding: "caller",
                    identity: "selected",
                    policy: { maxSubscriptions: 1 },
                    changes: Effect.succeed(Stream.never),
                    capture: (
                        _tx: Transaction,
                        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
                    ) =>
                        emit({ kind: "base", objectType: "Row", key: "one", value: { value } }).pipe(
                            Effect.as({ ...metadata, revision: value })
                        ),
                };
                const producerScope = yield* Scope.make();
                const first = yield* Scope.provide(firstOwner.open(config), producerScope);
                const frames = yield* first.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                const installed = frames.at(-1)!;
                yield* Scope.close(producerScope, Exit.void);
                yield* Scope.close(ownerScope, Exit.void);
                const replacement = yield* makeDeliveryManager({ tables, namespace: "owner-loss" });
                const sessions = Table.make({ name: JSON.stringify(["owner-loss", "delivery", "sessions"]) });
                expect(
                    yield* Effect.result(replacement.open({ ...config, binding: "other", resume: installed }))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "HistoryExpired" },
                });
                expect(yield* tables.query(sessions)).toHaveLength(1);
                expect(
                    yield* Effect.result(replacement.open({ ...config, resume: installed }))
                ).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "HistoryExpired" },
                });
                // Expiry must commit before the error, otherwise maxSubscriptions:1
                // would permanently prevent rebuilding this lost data view.
                expect(yield* tables.query(sessions)).toHaveLength(0);
                value = 2;
                const fresh = yield* replacement.open(config);
                const recovered = yield* fresh.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                expect(recovered[0]).toMatchObject({ kind: "snapshot", sequence: 1, previous: 0 });
                expect(recovered[0]!.streamId).not.toBe(installed.streamId);
                expect(recovered.flatMap((frame) => frame.changes)).toEqual([
                    {
                        kind: "put",
                        record: { kind: "base", objectType: "Row", key: "one", value: { value: 2 } },
                    },
                ]);
                expect(yield* tables.get(durableActions, "action")).toEqual({ outcome: "committed" });
                yield* fresh.acknowledge(recovered.at(-1)!);
            })
        )
    );
});

const assertAbortedCapture = Effect.fnUntraced(function* (interrupt: boolean) {
    yield* Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const deliveries = yield* makeDeliveryManager({ tables, namespace: "capture-abort" });
            const marker = Table.make<boolean>({ name: "capture-marker" });
            const entered = yield* Queue.unbounded<void>();
            let abort = true;
            const config = {
                binding: "caller",
                identity: "selected",
                changes: Effect.succeed(Stream.never),
                capture: (
                    tx: Transaction,
                    emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
                ) =>
                    Effect.gen(function* () {
                        // Cross the hashing page boundary before failing or interruption.
                        for (let key = 0; key < 129; key++)
                            yield* emit({ kind: "base", objectType: "Row", key, value: { id: key } });
                        yield* tx.put(marker, "uncommitted", true).pipe(Effect.orDie);
                        if (abort) {
                            yield* Queue.offer(entered, undefined);
                            if (interrupt) yield* Effect.never;
                            else
                                return yield* new BackendError({
                                    operation: "capture",
                                    kind: "Unavailable",
                                    retryable: true,
                                    message: "Aborted capture",
                                });
                        }
                        return metadata;
                    }),
            };
            const scope = yield* Scope.make();
            const first = yield* Scope.provide(deliveries.open(config), scope);
            const running = yield* Scope.provide(
                Stream.runDrain(first.frames).pipe(Effect.forkScoped),
                scope
            );
            yield* Queue.take(entered);
            if (interrupt) yield* Fiber.interrupt(running);
            else expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true);
            yield* Scope.close(scope, Exit.void);
            expect(yield* tables.get(marker, "uncommitted")).toBeUndefined();
            const session = (yield* tables.query(
                Table.make({ name: JSON.stringify(["capture-abort", "delivery", "sessions"]) })
            ))[0]!;
            abort = false;
            const recovered = yield* deliveries.open({
                ...config,
                resume: { streamId: String(session.key), sequence: 0 },
            });
            const frames = yield* recovered.frames.pipe(
                Stream.takeUntil((frame) => frame.end),
                Stream.runCollect
            );
            expect(frames.flatMap((frame) => frame.changes)).toHaveLength(129);
            expect(frames[0]!.kind).toBe("snapshot");
            yield* recovered.acknowledge(frames.at(-1)!);
        })
    );
});

test("failed capture commits neither source writes nor temporary target hashes", () =>
    Effect.runPromise(assertAbortedCapture(false)));
test("interrupted capture commits neither source writes nor temporary target hashes", () =>
    Effect.runPromise(assertAbortedCapture(true)));

test("pending owner buffers are canonical copies, including across a producer restart", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "immutable-buffer" });
                const value = { nested: { value: 1 } };
                let captures = 0;
                const config = {
                    binding: "caller",
                    identity: "selected",
                    changes: Effect.succeed(Stream.never),
                    capture: (
                        _tx: Transaction,
                        emit: (record: DeliveryRecord) => Effect.Effect<void, BackendError>
                    ) =>
                        Effect.gen(function* () {
                            captures++;
                            yield* emit({ kind: "base", objectType: "Row", key: "one", value });
                            value.nested.value = 2;
                            return metadata;
                        }),
                };
                const scope = yield* Scope.make();
                const first = yield* Scope.provide(deliveries.open(config), scope);
                const frames = yield* first.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                const initial = frames[0]!;
                expect(initial.changes).toMatchObject([{ record: { value: { nested: { value: 1 } } } }]);
                const change = initial.changes[0]!;
                if (change.kind === "put" && change.record.kind === "base")
                    (change.record.value.nested as { value: number }).value = 77;
                yield* Scope.close(scope, Exit.void);
                const resumed = yield* deliveries.open({
                    ...config,
                    resume: { streamId: initial.streamId, sequence: 0 },
                });
                const replay = yield* resumed.frames.pipe(
                    Stream.takeUntil((frame) => frame.end),
                    Stream.runCollect
                );
                expect(captures).toBe(1);
                expect(replay[0]!.changes).toMatchObject([{ record: { value: { nested: { value: 1 } } } }]);
                yield* resumed.acknowledge(replay.at(-1)!);
            })
        )
    );
});

test("quiet active view heartbeats renew owner buffers beyond disconnected retention", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const deliveries = yield* makeDeliveryManager({ tables, namespace: "active-retention" });
                const renewed = yield* Queue.unbounded<number>();
                let captures = 0;
                const ends = yield* Queue.unbounded<DeliveryFrame>();
                const scope = yield* Scope.make();
                const subscription = yield* Scope.provide(
                    deliveries.open({
                        binding: "caller",
                        identity: "selected",
                        policy: { retentionMs: 10 },
                        changes: Effect.succeed(Stream.never),
                        renew: () =>
                            Clock.currentTimeMillis.pipe(
                                Effect.flatMap((now) => Queue.offer(renewed, now)),
                                Effect.asVoid
                            ),
                        capture: () =>
                            Effect.sync(() => {
                                captures++;
                                return metadata;
                            }),
                    }),
                    scope
                );
                yield* Scope.provide(
                    Stream.runForEach(subscription.frames, (frame) =>
                        frame.end ? Queue.offer(ends, frame) : Effect.void
                    ).pipe(Effect.forkScoped),
                    scope
                );
                const first = yield* Queue.take(ends);
                yield* subscription.acknowledge(first);
                for (let n = 0; n < 4; n++) {
                    yield* TestClock.adjust(30_000);
                    const now = yield* Clock.currentTimeMillis;
                    while ((yield* Queue.take(renewed)) < now) {
                        /* wait for this lease renewal */
                    }
                    expect(captures).toBe(1);
                    expect(yield* deliveries.collectGarbage).toBe(0);
                }
                yield* Scope.close(scope, Exit.void);
                yield* TestClock.adjust(11);
                expect(yield* deliveries.collectGarbage).toBe(1);
            })
        ).pipe(Effect.provide(TestClock.layer()))
    );
});

const assertOwnerCloseWakes = Effect.fnUntraced(function* (acknowledge: boolean) {
    yield* Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const owner = yield* Scope.make();
            const deliveries = yield* Scope.provide(
                makeDeliveryManager({ tables, namespace: "close-wakeup" }),
                owner
            );
            const producer = yield* Scope.make();
            const ends = yield* Queue.unbounded<DeliveryFrame>();
            const subscription = yield* Scope.provide(
                deliveries.open({
                    binding: "caller",
                    identity: "selected",
                    changes: Effect.succeed(Stream.never),
                    capture: () => Effect.succeed(metadata),
                }),
                producer
            );
            const running = yield* Scope.provide(
                Stream.runForEach(subscription.frames, (frame) =>
                    frame.end ? Queue.offer(ends, frame) : Effect.void
                ).pipe(Effect.forkScoped),
                producer
            );
            const first = yield* Queue.take(ends);
            if (acknowledge) {
                yield* subscription.acknowledge(first);
                const sessions = Table.make<{ installed: number }>({
                    name: JSON.stringify(["close-wakeup", "delivery", "sessions"]),
                });
                while ((yield* tables.get(sessions, first.streamId))?.installed !== first.sequence)
                    yield* Effect.yieldNow;
            }
            yield* Effect.yieldNow;
            yield* Scope.close(owner, Exit.void);
            expect(yield* Effect.result(Fiber.join(running)).pipe(Effect.timeout("1 second"))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "HistoryExpired" },
            });
            yield* Scope.close(producer, Exit.void);
        })
    );
});

test("closing an owner fails a quiet view immediately instead of waiting for its heartbeat", () =>
    Effect.runPromise(assertOwnerCloseWakes(true)));
test("closing an owner fails an unacknowledged view with typed expiry, not interruption", () =>
    Effect.runPromise(assertOwnerCloseWakes(false)));
