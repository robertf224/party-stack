import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Deferred, Exit, Fiber, Scope } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test, vi } from "vite-plus/test";
import { makeDeliveryReceiver } from "./delivery.js";
import { BackendError } from "./index.js";
import type { IncomingDelivery, DeliveryChange, DeliveryFrame } from "./delivery.js";
import type { Transaction } from "@party-stack/ontology-storage/tables";

const metadata = { sourceId: "authority", schemaHash: "schema", generation: 1, revision: 1, coverage: [] };
const rows = Table.make<{ id: string; value: number }>({ name: "application" });
const evidence = Table.make<number>({ name: "evidence" });
const failure = new BackendError({
    operation: "test",
    kind: "Unavailable",
    retryable: true,
    message: "apply failed",
});
const put = (id: string, value = 1): DeliveryChange => ({
    kind: "put",
    record: { kind: "base", objectType: "Row", key: id, value: { id, value } },
});
const first: DeliveryFrame = {
    streamId: "stream",
    sequence: 1,
    previous: 0,
    kind: "snapshot",
    part: 0,
    changes: [put("one")],
    end: false,
};
const last: DeliveryFrame = { ...first, part: 1, changes: [], end: true, metadata };
const apply = (tx: Transaction, batch: IncomingDelivery) =>
    Effect.gen(function* () {
        if (batch.kind === "snapshot") yield* tx.clear(rows).pipe(Effect.orDie);
        yield* batch.forEach((change) => {
            if (change.kind === "put" && change.record.kind === "base")
                return tx
                    .put(rows, change.record.key, change.record.value as { id: string; value: number })
                    .pipe(Effect.orDie);
            if (change.kind === "remove" && change.ref.kind === "base")
                return tx.delete(rows, change.ref.key).pipe(Effect.orDie);
            return Effect.void;
        });
    });
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

test("partial frames never publish, failed final apply rolls back while receipt evidence survives, and duplicate replay skips apply", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            yield* tables.put(rows, "old", { id: "old", value: 0 });
            let fails = true;
            let applies = 0;
            const receiver = yield* makeDeliveryReceiver({
                tables,
                namespace: "atomic",
                beforeApply: (tx) => tx.put(evidence, "receipt", 1).pipe(Effect.orDie),
                apply: (tx, batch) =>
                    apply(tx, batch).pipe(
                        Effect.andThen(
                            Effect.suspend(() =>
                                fails
                                    ? Effect.fail(failure)
                                    : Effect.sync(() => {
                                          applies++;
                                      })
                            )
                        )
                    ),
            });
            yield* receiver.receive(first);
            expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["old"]);
            yield* receiver.receive(first);
            expect((yield* Effect.result(receiver.receive(last)))._tag).toBe("Failure");
            expect(yield* tables.get(evidence, "receipt")).toBe(1);
            expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["old"]);
            expect(yield* receiver.installed).toBeUndefined();
            fails = false;
            yield* receiver.receive(last);
            yield* receiver.receive(first);
            expect((yield* receiver.receive(last))?.duplicate).toBe(true);
            expect(applies).toBe(1);
            expect((yield* tables.query(rows)).map((row) => row.key)).toEqual(["one"]);
            yield* receiver.receive({ ...first, changes: [] });
            expect(yield* Effect.result(receiver.receive(last))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "Conflict" },
            });
        })
    ));

test("retained frame strings isolate input, receipt callbacks, repeated traversals and apply metadata", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const observed: number[] = [];
            const input = { ...first, changes: [put("one", 7)] };
            const finalInput = { ...last, metadata: { ...metadata } };
            const receiver = yield* makeDeliveryReceiver({
                tables,
                namespace: "isolated",
                beforeApply: (_tx, batch) =>
                    Effect.gen(function* () {
                        finalInput.metadata.revision = 300;
                        (batch.metadata as { revision: number }).revision = 100;
                        yield* batch.forEach((change) =>
                            Effect.sync(() => {
                                if (change.kind === "put" && change.record.kind === "base")
                                    (change.record.value as { value: number }).value = 999;
                            })
                        );
                        yield* batch.forEach((change) =>
                            Effect.sync(() => {
                                if (change.kind === "put" && change.record.kind === "base")
                                    observed.push(change.record.value.value as number);
                            })
                        );
                    }),
                apply: (tx, batch) =>
                    Effect.gen(function* () {
                        expect(batch.metadata.revision).toBe(1);
                        yield* apply(tx, batch);
                        (batch.metadata as { revision: number }).revision = 200;
                    }),
            });
            yield* receiver.receive(input);
            const original = input.changes[0]!;
            if (original.kind === "put" && original.record.kind === "base")
                (original.record.value as { value: number }).value = 1000;
            const result = yield* receiver.receive(finalInput);
            expect(observed).toEqual([7]);
            expect(yield* tables.get(rows, "one")).toEqual({ id: "one", value: 7 });
            if (!result) throw new Error("Final frame must return its installed metadata.");
            expect(result.metadata.revision).toBe(1);
            (result.metadata as { revision: number }).revision = 400;
            expect((yield* receiver.installed)?.metadata?.revision).toBe(1);
        })
    ));

test("metadata copies do not reconstruct row values while each traversal still gets fresh records", async () => {
    const instant = Temporal.Instant.from("2026-11-09T12:00:00Z");
    const from = vi.spyOn(Temporal.Instant, "from");
    try {
        await run(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const visits: object[][] = [[], []];
                const receiver = yield* makeDeliveryReceiver({
                    tables,
                    namespace: "metadata-work-bound",
                    beforeApply: (_tx, batch) =>
                        Effect.sync(() => {
                            expect(from).not.toHaveBeenCalled();
                            (batch.metadata as { revision: number }).revision = 100;
                        }),
                    apply: (_tx, batch) =>
                        Effect.gen(function* () {
                            expect(batch.metadata.revision).toBe(1);
                            expect(from).not.toHaveBeenCalled();
                            for (const traversal of visits)
                                yield* batch.forEach((change) =>
                                    Effect.sync(() => {
                                        if (change.kind === "put" && change.record.kind === "base")
                                            traversal.push(change.record.value);
                                    })
                                );
                            (batch.metadata as { revision: number }).revision = 200;
                        }),
                });
                const frame: DeliveryFrame = {
                    ...first,
                    end: true,
                    metadata,
                    changes: Array.from({ length: 17 }, (_, n) => ({
                        kind: "put",
                        record: {
                            kind: "base",
                            objectType: "Row",
                            key: String(n),
                            value: { id: String(n), at: instant },
                        },
                    })),
                };
                const result = yield* receiver.receive(frame);
                expect(visits.map((rows) => rows.length)).toEqual([17, 17]);
                expect(visits[0]![0]).not.toBe(visits[1]![0]);
                expect(from).toHaveBeenCalledTimes(34);
                expect(result?.metadata.revision).toBe(1);
                expect((yield* receiver.installed)?.metadata?.revision).toBe(1);
                yield* receiver.receive(frame);
                expect(from).toHaveBeenCalledTimes(34);
            })
        );
    } finally {
        from.mockRestore();
    }
});

test("receiver replacement fences every old operation including a new part zero", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const old = yield* makeDeliveryReceiver({ tables, namespace: "fence", apply });
            yield* old.receive(first);
            const current = yield* makeDeliveryReceiver({ tables, namespace: "fence", apply });
            const oldOperations: readonly Effect.Effect<unknown, BackendError>[] = [
                old.receive(first),
                old.receive(last),
                old.forget,
                old.resume,
                old.installed,
            ];
            for (const operation of oldOperations)
                expect(yield* Effect.result(operation)).toMatchObject({
                    _tag: "Failure",
                    failure: { kind: "ViewReplaced" },
                });
            expect(yield* current.resume).toBeUndefined();
            expect(yield* Effect.result(current.receive(last))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "HistoryExpired" },
            });
            yield* current.receive(first);
            yield* current.receive(last);
            expect(yield* tables.get(rows, "one")).toEqual({ id: "one", value: 1 });
        })
    ));

test("scope loss drops partial bytes, resumes only installed position and permits whole patch replay", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const scope = yield* Scope.make();
            const old = yield* Scope.provide(
                makeDeliveryReceiver({ tables, namespace: "resume", apply }),
                scope
            );
            yield* old.receive(first);
            yield* old.receive(last);
            const patch: DeliveryFrame = {
                ...first,
                sequence: 2,
                previous: 1,
                kind: "patch",
                changes: [put("one", 2)],
            };
            yield* old.receive(patch);
            yield* Scope.close(scope, Exit.void);
            expect(
                yield* Effect.result(old.receive({ ...patch, part: 1, changes: [], end: true, metadata }))
            ).toMatchObject({ _tag: "Failure", failure: { kind: "ViewReplaced" } });
            const reopened = yield* makeDeliveryReceiver({ tables, namespace: "resume", apply });
            expect(yield* reopened.resume).toEqual({ streamId: "stream", sequence: 1 });
            expect(
                yield* Effect.result(
                    reopened.receive({ ...patch, part: 1, changes: [], end: true, metadata })
                )
            ).toMatchObject({ _tag: "Failure", failure: { kind: "HistoryExpired" } });
            expect(yield* tables.get(rows, "one")).toEqual({ id: "one", value: 1 });
            yield* reopened.receive(patch);
            yield* reopened.receive({ ...patch, part: 1, changes: [], end: true, metadata });
            expect(yield* tables.get(rows, "one")).toEqual({ id: "one", value: 2 });
        })
    ));

test("order, metadata, byte, row and empty-frame budgets reject without corrupting the retained prefix", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const receiver = yield* makeDeliveryReceiver({
                tables,
                namespace: "bounds",
                maxRecords: 1,
                apply,
            });
            expect(yield* Effect.result(receiver.receive(last))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "HistoryExpired" },
            });
            yield* receiver.receive(first);
            for (const invalid of [
                { ...first, part: 2 },
                { ...first, part: 1 },
                { ...last, metadata: undefined },
            ])
                expect((yield* Effect.result(receiver.receive(invalid)))._tag).toBe("Failure");
            yield* receiver.receive(last);
            expect((yield* receiver.installed)?.sequence).toBe(1);
            const small = yield* makeDeliveryReceiver({ tables, namespace: "bytes", maxBytes: 1, apply });
            expect(yield* Effect.result(small.receive(first))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "InvalidResponse" },
            });
            const empties = yield* makeDeliveryReceiver({
                tables,
                namespace: "empties",
                maxRecords: 1,
                apply,
            });
            for (const part of [0, 1, 2]) yield* empties.receive({ ...first, part, changes: [] });
            expect(yield* Effect.result(empties.receive({ ...last, part: 3 }))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "InvalidResponse" },
            });
            expect(yield* empties.installed).toBeUndefined();
            const zero = yield* makeDeliveryReceiver({ tables, namespace: "zero", maxRecords: 0, apply });
            yield* zero.receive({ ...first, changes: [], end: true, metadata });
            expect((yield* zero.installed)?.count).toBe(0);
        })
    ));

test("first acquisition atomically drops legacy staging while preserving installed position", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const changes = Table.make({ name: JSON.stringify(["legacy", "incoming-delivery", "changes"]) });
            const hashes = Table.make({ name: JSON.stringify(["legacy", "incoming-delivery", "frames"]) });
            const state = Table.make({ name: JSON.stringify(["legacy", "incoming-delivery", "state"]) });
            const owner = Table.make<number>({
                name: JSON.stringify(["legacy", "incoming-delivery", "owner"]),
            });
            yield* tables.put(changes, 0, { change: put("partial") });
            yield* tables.put(hashes, 0, "old-hash");
            yield* tables.put(state, "pending", { streamId: "partial", sequence: 1 });
            const installed = {
                streamId: "stream",
                sequence: 1,
                previous: 0,
                nextPart: 2,
                count: 1,
                bytes: 128,
                hash: "legacy-installed",
                kind: "snapshot",
                duplicate: false,
                metadata,
            };
            yield* tables.put(state, "installed", installed);
            // A different unfinished stream is not an installation proof.
            yield* tables.put(state, "pending", { streamId: "partial", sequence: 1 });
            yield* tables.put(changes, 0, { change: put("partial") });
            yield* tables.put(hashes, 0, "old-hash");
            const current = yield* makeDeliveryReceiver({ tables, namespace: "legacy", apply });
            expect(yield* current.installed).toEqual(installed);
            expect(yield* current.resume).toEqual({ streamId: "stream", sequence: 1 });
            expect(yield* tables.query(changes)).toEqual([]);
            expect(yield* tables.query(hashes)).toEqual([]);
            expect(yield* tables.get(state, "pending")).toBeUndefined();
            expect(yield* tables.get(owner, "active")).toBe(1);
        })
    ));

test("forget serializes after an in-flight install and clears the committed marker and local prefix", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const receiver = yield* makeDeliveryReceiver({
                tables,
                namespace: "forget",
                apply: (tx, batch) =>
                    Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(apply(tx, batch))
                    ),
            });
            yield* receiver.receive(first);
            const installing = yield* receiver.receive(last).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const forgetting = yield* receiver.forget.pipe(Effect.forkScoped);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(installing);
            yield* Fiber.join(forgetting);
            expect(yield* receiver.installed).toBeUndefined();
            expect(yield* receiver.resume).toBeUndefined();
            expect(
                yield* Effect.result(receiver.receive({ ...first, sequence: 2, previous: 1, kind: "patch" }))
            ).toMatchObject({ _tag: "Failure", failure: { kind: "HistoryExpired" } });
        })
    ));

test("a replacement during the durable receipt checkpoint cannot install old data afterwards", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const wrapped: typeof tables = {
                ...tables,
                transaction: (body) =>
                    tables
                        .transaction(body)
                        .pipe(
                            Effect.tap(() =>
                                Effect.suspend(() =>
                                    checkpoint
                                        ? Deferred.succeed(entered, undefined).pipe(
                                              Effect.andThen(Deferred.await(release))
                                          )
                                        : Effect.void
                                )
                            )
                        ),
            };
            let checkpoint = false;
            const old = yield* makeDeliveryReceiver({
                tables: wrapped,
                namespace: "checkpoint",
                beforeApply: (tx) =>
                    tx.put(evidence, "receipt", 1).pipe(
                        Effect.orDie,
                        Effect.tap(() =>
                            Effect.sync(() => {
                                checkpoint = true;
                            })
                        )
                    ),
                apply,
            });
            yield* old.receive(first);
            const running = yield* old.receive(last).pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(entered);
            const current = yield* makeDeliveryReceiver({ tables, namespace: "checkpoint", apply });
            yield* Deferred.succeed(release, undefined);
            expect(yield* Fiber.join(running)).toMatchObject({
                _tag: "Failure",
                failure: { kind: "ViewReplaced" },
            });
            expect(yield* tables.get(evidence, "receipt")).toBe(1);
            expect(yield* tables.query(rows)).toEqual([]);
            expect(yield* current.installed).toBeUndefined();
        })
    ));

test("interruption after the receipt checkpoint retains evidence and permits exact final-frame retry", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const entered = yield* Deferred.make<void>();
            let pause = true;
            let checkpoint = false;
            const wrapped: typeof tables = {
                ...tables,
                transaction: (body) =>
                    tables
                        .transaction(body)
                        .pipe(
                            Effect.tap(() =>
                                Effect.suspend(() =>
                                    checkpoint && pause
                                        ? Deferred.succeed(entered, undefined).pipe(
                                              Effect.andThen(Effect.never)
                                          )
                                        : Effect.void
                                )
                            )
                        ),
            };
            const receiver = yield* makeDeliveryReceiver({
                tables: wrapped,
                namespace: "interrupt",
                beforeApply: (tx) =>
                    tx.put(evidence, "receipt", 1).pipe(
                        Effect.orDie,
                        Effect.tap(() =>
                            Effect.sync(() => {
                                checkpoint = true;
                            })
                        )
                    ),
                apply,
            });
            yield* receiver.receive(first);
            const running = yield* receiver.receive(last).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(running);
            expect(yield* tables.get(evidence, "receipt")).toBe(1);
            expect(yield* tables.query(rows)).toEqual([]);
            expect(yield* receiver.installed).toBeUndefined();
            pause = false;
            yield* receiver.receive(last);
            expect(yield* tables.get(rows, "one")).toEqual({ id: "one", value: 1 });
            expect((yield* receiver.installed)?.sequence).toBe(1);
        })
    ));

test("replacement acquisition waits for an atomic in-flight install, then permanently fences its owner", async () =>
    run(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const old = yield* makeDeliveryReceiver({
                tables,
                namespace: "atomic-owner",
                apply: (tx, batch) =>
                    Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(apply(tx, batch))
                    ),
            });
            yield* old.receive(first);
            const installing = yield* old.receive(last).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const replacing = yield* makeDeliveryReceiver({ tables, namespace: "atomic-owner", apply }).pipe(
                Effect.forkScoped
            );
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(installing);
            const current = yield* Fiber.join(replacing);
            expect((yield* current.installed)?.sequence).toBe(1);
            expect(yield* Effect.result(old.receive(first))).toMatchObject({
                _tag: "Failure",
                failure: { kind: "ViewReplaced" },
            });
        })
    ));
