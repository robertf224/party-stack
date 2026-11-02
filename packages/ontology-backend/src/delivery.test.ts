/* The Vitest wrapper from @fast-check/vitest is a test block. */
/* eslint-disable vitest/no-standalone-expect */
import { fc, test } from "@fast-check/vitest";
import { eq, gte, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, PubSub, Queue, Stream, Scope, Exit } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import {
    acknowledgeDelivery,
    collectDeliveryGarbage,
    makeDelivery,
    makeDeliveryReceiver,
    scanDeliveryRows,
    type DeliveryFrame,
} from "./delivery.js";
import { BackendError } from "./index.js";

const operation = fc.record({
    key: fc.integer({ min: 0, max: 10 }),
    value: fc.integer({ min: -50, max: 50 }),
    remove: fc.boolean(),
});

test.prop(
    [
        fc.array(operation, { maxLength: 35 }),
        fc.record({
            minimum: fc.integer({ min: 0, max: 10 }),
            limit: fc.integer({ min: 0, max: 8 }),
            offset: fc.integer({ min: 0, max: 3 }),
            descending: fc.boolean(),
        }),
    ],
    { numRuns: 60 }
)(
    "incremental delivery agrees with an independent full-snapshot oracle after every write",
    async (operations, selection) => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const tables = yield* Memory.make();
                    const rows = Table.make<{ id: number; value: number }>({ name: "rows" });
                    const events = yield* PubSub.sliding<void>(1);
                    const complete = yield* Queue.unbounded<DeliveryFrame>();
                    let revision = 1;
                    const subscription = yield* makeDelivery({
                        binding: "test",
                        identity: "selection",
                        namespace: "oracle",
                        tables,
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
            )
        );
    }
);

test("a slow consumer holds one batch and coalesces intervening writes", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const events = yield* PubSub.sliding<void>(1);
                const batches = yield* Queue.unbounded<DeliveryFrame>();
                let revision = 1;
                let captures = 0;
                let value = 0;
                const subscription = yield* makeDelivery({
                    binding: "test",
                    identity: "selection",
                    tables,
                    namespace: "slow",
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

test("acknowledgments from another handler use stored positions; scope cleanup retains resumable delivery records", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                yield* Effect.scoped(
                    Effect.gen(function* () {
                        const events = yield* PubSub.sliding<void>(1);
                        const ends = yield* Queue.unbounded<DeliveryFrame>();
                        let revision = 1;
                        const subscription = yield* makeDelivery({
                            binding: "test",
                            identity: "selection",
                            tables,
                            namespace: "http",
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

test("stored batches resume after producer/receiver recreation and lost acknowledgments without reapplying", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
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
                    makeDelivery({
                        tables,
                        namespace: "resume",
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
                const next = yield* makeDelivery({
                    tables,
                    namespace: "resume",
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
                const scope = yield* Scope.make();
                const config = {
                    tables,
                    namespace: "expiry",
                    binding: "authority",
                    identity: "query",
                    policy: { retentionMs: 10 },
                    changes: Effect.succeed(Stream.never),
                    capture: () => Effect.succeed(metadata),
                };
                const first = yield* Scope.provide(makeDelivery(config), scope);
                const frames = yield* Stream.runCollect(first.frames.pipe(Stream.take(1)));
                const position = { streamId: frames[0]!.streamId, sequence: 0 };
                yield* TestClock.adjust(11);
                expect(yield* collectDeliveryGarbage(tables, "expiry")).toBe(0);
                yield* Scope.close(scope, Exit.void);
                yield* TestClock.adjust(11);
                expect(yield* collectDeliveryGarbage(tables, "expiry")).toBe(1);
                expect(yield* Effect.result(makeDelivery({ ...config, resume: position }))).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "HistoryExpired" },
                });
                const fresh = yield* makeDelivery(config);
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
                const config = {
                    tables,
                    namespace: "replace",
                    binding: "authority",
                    identity: "first",
                    policy: { maxSubscriptions: 1 },
                    changes: Effect.succeed(Stream.never),
                    capture: () => Effect.succeed(metadata),
                };
                const first = yield* makeDelivery(config);
                const initial = (yield* Stream.runCollect(first.frames.pipe(Stream.take(1))))[0]!;
                const second = yield* makeDelivery({
                    ...config,
                    identity: "second",
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

test("metadata and single-row updates do not rewrite unchanged durable witnesses", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                let witnessWrites = 0;
                let witnessDeletes = 0;
                const instrumented: typeof tables = {
                    ...tables,
                    transaction: (body) =>
                        tables.transaction((tx) =>
                            body({
                                ...tx,
                                put: (table, key, value) => {
                                    if (table.name.endsWith('"records"]')) witnessWrites++;
                                    return tx.put(table, key, value);
                                },
                                delete: (table, key) => {
                                    if (table.name.endsWith('"records"]')) witnessDeletes++;
                                    return tx.delete(table, key);
                                },
                            })
                        ),
                };
                const values = new Map(Array.from({ length: 200 }, (_, id) => [id, 0]));
                let revision = 1;
                const events = yield* PubSub.sliding<void>(1);
                const batches = yield* Queue.unbounded<DeliveryFrame>();
                const subscription = yield* makeDelivery({
                    tables: instrumented,
                    namespace: "write-amplification",
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
                expect(witnessWrites).toBe(200);
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
                expect(witnessWrites).toBe(1);
                yield* subscription.acknowledge(third);
                values.delete(3);
                revision++;
                yield* PubSub.publish(events, undefined);
                const fourth = yield* Queue.take(batches);
                expect(fourth.changes).toEqual([
                    { kind: "remove", ref: { kind: "base", objectType: "Row", key: 3 } },
                ]);
                expect(witnessWrites).toBe(1);
                expect(witnessDeletes).toBe(1);
                yield* subscription.acknowledge(fourth);
            })
        ).pipe(Effect.timeout("10 seconds"))
    );
});
