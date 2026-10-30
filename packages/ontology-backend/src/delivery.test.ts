/* The Vitest wrapper from @fast-check/vitest is a test block. */
/* eslint-disable vitest/no-standalone-expect */
import { fc, test } from "@fast-check/vitest";
import { eq, gte, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, PubSub, Queue, Stream } from "effect";
import { expect } from "vite-plus/test";
import {
    acknowledgeDelivery,
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

test("acknowledgments from another handler use stored positions; scope cleanup removes delivery records", async () => {
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
                expect(yield* tables.query(sessions, { where: eq(field("expected"), 2) })).toEqual([]);
                expect(yield* tables.query(records)).toEqual([]);
            })
        )
    );
});
