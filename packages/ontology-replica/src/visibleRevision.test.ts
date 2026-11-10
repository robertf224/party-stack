import { it } from "@effect/vitest";
import { classifyBackendFailure } from "@party-stack/ontology-backend";
import { makeOwnedBackend } from "@party-stack/ontology-backend/owned";
import { o } from "@party-stack/ontology-spec";
import { evaluateQuery, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Deferred, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { expect } from "vitest";
import { readVisibleRevision } from "./infrastructure.js";
import { kernel, replicaController } from "./internal.js";
import { makeReplica } from "./service.js";
import { observeRows } from "./visible.js";
import type { VisibleCommit } from "./visible.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Query, Row } from "@party-stack/ontology-storage";

type Value = Record<string, unknown>;
interface Snapshot {
    revision: number;
    rows: readonly Row<Value>[];
}
const row = (id: string, value: number): Row<Value> => ({ key: id, value: { id, value } });

const fixture = Effect.fnUntraced(function* () {
    const tables = yield* Memory.make();
    const state = Table.make<Snapshot>({ name: "visible-revision-test" });
    yield* tables.put(state, "head", { revision: 0, rows: [] });
    const events = yield* PubSub.unbounded<VisibleCommit>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const read = tables.read;
    const observe = (
        query?: Query,
        hold?: { captured: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    ) => {
        let first = true;
        return observeRows({
            objectType: "Item",
            query,
            changes: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
            read: (body) =>
                Effect.gen(function* () {
                    const snapshot = yield* read(body);
                    if (first && hold) {
                        first = false;
                        yield* Deferred.succeed(hold.captured, undefined);
                        yield* Deferred.await(hold.release);
                    }
                    return snapshot;
                }).pipe(Effect.mapError((cause) => classifyBackendFailure("test.observe", cause))),
            snapshot: (tx) =>
                Effect.gen(function* () {
                    const current = (yield* tx.get(state, "head"))!;
                    return { revision: current.revision, rows: evaluateQuery(current.rows, query) };
                }),
        });
    };
    return {
        observe,
        fence: tables.get(state, "head").pipe(Effect.map((snapshot) => snapshot!.revision)),
        save: (revision: number, rows: readonly Row<Value>[]) =>
            tables.put(state, "head", { revision, rows }),
        publish: (commit: VisibleCommit) => PubSub.publish(events, commit),
    };
});

it.effect("a fence can be newer than a held observation until its commit is consumed", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const pull = yield* Stream.toPull(f.observe());
            const initial = (yield* pull)[0]!;
            expect(initial).toEqual({ revision: 0, reset: true, rows: [], removed: [] });

            yield* f.save(1, [row("one", 1)]);
            const fence = yield* f.fence;
            expect(initial.revision).toBeLessThan(fence);
            yield* f.publish({
                revision: 1,
                previous: 0,
                reset: false,
                changes: [{ objectType: "Item", ...row("one", 1) }],
            });
            const caughtUp = (yield* pull)[0]!;
            expect(caughtUp).toEqual({ revision: fence, reset: false, rows: [row("one", 1)], removed: [] });
        })
    )
);

it.effect("unrelated and stale queued commits advance or retain the global observation revision", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const pull = yield* Stream.toPull(f.observe());
            yield* pull;
            yield* f.save(1, []);
            yield* f.publish({
                revision: 1,
                previous: 0,
                reset: false,
                changes: [{ objectType: "Other", ...row("one", 1) }],
            });
            expect((yield* pull)[0]).toEqual({ revision: 1, reset: false, rows: [], removed: [] });

            yield* f.publish({ revision: 0, previous: 0, reset: false, changes: [] });
            expect((yield* pull)[0]).toEqual({ revision: 1, reset: false, rows: [], removed: [] });
        })
    )
);

it.effect("a gap reports the repair snapshot revision even when it is ahead of the queued event", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const pull = yield* Stream.toPull(f.observe());
            yield* pull;
            yield* f.save(3, [row("three", 3)]);
            yield* f.publish({ revision: 2, previous: 1, reset: false, changes: [] });
            expect((yield* pull)[0]).toEqual({
                revision: 3,
                reset: true,
                rows: [row("three", 3)],
                removed: [],
            });
            yield* f.publish({
                revision: 3,
                previous: 2,
                reset: false,
                changes: [{ objectType: "Item", ...row("three", 3) }],
            });
            expect((yield* pull)[0]).toEqual({ revision: 3, reset: false, rows: [], removed: [] });
        })
    )
);

it.effect("sorted-window and reset repairs retain the revision of their exact membership", () =>
    Effect.scoped(
        Effect.gen(function* () {
            const f = yield* fixture();
            const pull = yield* Stream.toPull(f.observe({ limit: 1, orderBy: [{ field: field("value") }] }));
            yield* pull;
            yield* f.save(1, [row("one", 2), row("two", 1)]);
            yield* f.publish({
                revision: 1,
                previous: 0,
                reset: false,
                changes: [
                    { objectType: "Item", ...row("one", 2) },
                    { objectType: "Item", ...row("two", 1) },
                ],
            });
            expect((yield* pull)[0]).toEqual({
                revision: 1,
                reset: true,
                rows: [row("two", 1)],
                removed: [],
            });
            yield* f.save(2, []);
            yield* f.publish({ revision: 2, previous: 1, reset: true, changes: [] });
            expect((yield* pull)[0]).toEqual({ revision: 2, reset: true, rows: [], removed: [] });
        })
    )
);

it.effect(
    "a write during initial snapshot delivery keeps the snapshot and later delta revisions separate",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const f = yield* fixture();
                const captured = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const pull = yield* Stream.toPull(f.observe(undefined, { captured, release }));
                const initial = yield* pull.pipe(Effect.forkScoped);
                yield* Deferred.await(captured);
                yield* f.save(1, [row("one", 1)]);
                yield* f.publish({
                    revision: 1,
                    previous: 0,
                    reset: false,
                    changes: [{ objectType: "Item", ...row("one", 1) }],
                });
                yield* Deferred.succeed(release, undefined);
                expect((yield* Fiber.join(initial))[0]).toEqual({
                    revision: 0,
                    reset: true,
                    rows: [],
                    removed: [],
                });
                expect((yield* pull)[0]).toEqual({
                    revision: 1,
                    reset: false,
                    rows: [row("one", 1)],
                    removed: [],
                });
            })
        )
);

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Item",
            displayName: "Item",
            pluralDisplayName: "Items",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "value", displayName: "Value", type: o.integer({}) },
            ],
        },
    ],
    actionTypes: [
        {
            name: "put",
            displayName: "Put",
            parameters: [{ name: "value", displayName: "Value", type: o.integer({}) }],
            logic: [],
        },
    ],
};

it.effect(
    "the infrastructure fence reads its replica's storage, tracks visible writes only, and closes with its owner",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const owner = yield* Scope.make();
                const replica = yield* makeReplica({
                    ir,
                    namespace: "visible-fence",
                    tables: yield* Memory.make(),
                    live: false,
                    backend: yield* makeOwnedBackend({
                        ir,
                        namespace: "visible-authority",
                        tables: yield* Memory.make(),
                        mutators: {},
                    }),
                    mutators: {
                        put: (tx, request) => tx.put("Item", { id: "one", value: request.parameters.value }),
                    },
                }).pipe(Scope.provide(owner));
                const controller = replicaController(replica);
                const fenceRead = readVisibleRevision(replica);
                if (!fenceRead) return yield* Effect.die("Expected a native observation fence.");
                const custom = { ...replica };
                Reflect.deleteProperty(custom, kernel);
                expect(readVisibleRevision(custom)).toBeUndefined();
                expect(yield* fenceRead).toBe(0);
                const pull = yield* Stream.toPull(
                    replica.observeSubset({ from: { source: { objectType: "Item" }, binding: "row" } })
                );
                const before = (yield* pull)[0]!;
                yield* controller.enqueue({ id: "one", name: "put", parameters: { value: 1 } });
                const fence = yield* fenceRead;
                expect(fence).toBeGreaterThan(before.revision);
                const after = (yield* pull)[0]!;
                expect(after.revision).toBe(fence);
                expect(after.rows).toEqual([row("one", 1)]);
                yield* controller.enqueue({ id: "same", name: "put", parameters: { value: 1 } });
                expect(yield* fenceRead).toBe(fence);
                yield* Scope.close(owner, Exit.void);
                expect(yield* fenceRead.pipe(Effect.flip)).toMatchObject({
                    kind: "InvalidRequest",
                });
            })
        )
);

it.effect(
    "successful local inserts advance observation fences while rejected inserts leave them unchanged",
    () =>
        Effect.scoped(
            Effect.gen(function* () {
                const namespace = "visible-insert";
                const replica = yield* makeReplica({
                    ir,
                    namespace,
                    tables: yield* Memory.make(),
                    live: false,
                    backend: yield* makeOwnedBackend({
                        ir,
                        namespace: "visible-insert-authority",
                        tables: yield* Memory.make(),
                        mutators: {},
                    }),
                });
                const controller = replicaController(replica);
                const fence = readVisibleRevision(replica);
                if (!fence) return yield* Effect.die("Expected a native observation fence.");
                const base = Table.make<Value>({ name: JSON.stringify(["replica", namespace, "base:Item"]) });
                const pull = yield* Stream.toPull(
                    replica.observeSubset({ from: { source: { objectType: "Item" }, binding: "row" } })
                );
                const initial = (yield* pull)[0]!;
                expect(
                    yield* controller.localTransaction((tx) => tx.insert(base, "one", row("one", 1).value))
                ).toBe(true);
                const inserted = yield* fence;
                expect(inserted).toBeGreaterThan(initial.revision);
                expect((yield* pull)[0]).toEqual({
                    revision: inserted,
                    reset: false,
                    rows: [row("one", 1)],
                    removed: [],
                });
                expect(
                    yield* controller.localTransaction((tx) => tx.insert(base, "one", row("one", 2).value))
                ).toBe(false);
                expect(yield* fence).toBe(inserted);
                // A distinct physical key still conflicts with the unique object primary key.
                expect(
                    yield* controller.localTransaction((tx) => tx.insert(base, "other", row("one", 3).value))
                ).toBe(false);
                expect(yield* fence).toBe(inserted);
                expect(
                    yield* replica.readSubset({ from: { source: { objectType: "Item" }, binding: "row" } })
                ).toEqual([row("one", 1)]);
            })
        )
);
