import { it } from "@effect/vitest";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Stream } from "effect";
import { expect } from "vite-plus/test";
import {
    makeDeliveryManager,
    type DeliveryManager,
    type DeliveryOpenOptions,
    type DeliveryPosition,
    type DeliveryRecord,
    type DeliverySubscription,
} from "./delivery.js";

const row = (key: string) =>
    ({
        kind: "base",
        objectType: "Row",
        key,
        value: { id: key, value: key.length },
    }) satisfies DeliveryRecord;
const openView = Effect.fnUntraced(function* (
    manager: DeliveryManager,
    view: {
        readonly generation: number;
        readonly rowSelection: string;
        readonly keys: readonly string[];
        readonly resume?: DeliveryPosition;
        readonly binding?: string;
    }
) {
    return yield* manager.open({
        binding: view.binding ?? "caller",
        identity: JSON.stringify({ generation: view.generation, selection: view.rowSelection }),
        rowSelection: view.rowSelection,
        resume: view.resume,
        policy: { maxSubscriptions: 1 },
        changes: Effect.succeed(Stream.never),
        capture: (_tx, emit) =>
            Effect.gen(function* () {
                for (const key of view.keys) yield* emit(row(key));
                return {
                    sourceId: "source",
                    schemaHash: "schema",
                    generation: view.generation,
                    revision: view.generation,
                    coverage: [],
                };
            }),
    });
});
const collect = Effect.fnUntraced(function* (subscription: DeliverySubscription) {
    return yield* subscription.frames.pipe(
        Stream.takeUntil((frame) => frame.end),
        Stream.runCollect
    );
});

it.effect.each([true, false])(
    "installed membership is reused across query changes (acknowledged: %s)",
    (acknowledged) =>
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const manager = yield* makeDeliveryManager({ tables, namespace: "query-reuse" });
            const first = yield* openView(manager, {
                generation: 1,
                rowSelection: "all rows",
                keys: ["one", "two"],
            });
            const initial = yield* collect(first);
            const installed = initial.at(-1)!;
            if (acknowledged) yield* first.acknowledge(installed);
            const second = yield* openView(manager, {
                generation: 2,
                rowSelection: "all rows plus the selected row one",
                keys: ["one", "two", "one"],
                resume: installed,
            });
            const next = yield* collect(second);
            expect(next).toHaveLength(1);
            expect(next[0]).toMatchObject({
                streamId: installed.streamId,
                sequence: installed.sequence + 1,
                previous: installed.sequence,
                kind: "patch",
                changes: [],
                metadata: { generation: 2 },
            });
            const sessions = Table.make<{ rowSelection: string }>({
                name: JSON.stringify(["query-reuse", "delivery", "sessions"]),
            });
            expect((yield* tables.get(sessions, installed.streamId))?.rowSelection).toBe(
                "all rows plus the selected row one"
            );
            yield* second.acknowledge(next[0]!);
        })
);

it.effect("query membership changes send only additions and removals, including a lost ACK", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const manager = yield* makeDeliveryManager({ tables, namespace: "query-delta" });
        const first = yield* openView(manager, {
            generation: 1,
            rowSelection: "first folder",
            keys: ["one", "two"],
        });
        const initial = yield* collect(first);
        const installed = initial.at(-1)!;
        // The client installed the target; its ACK did not reach the source.
        const second = yield* openView(manager, {
            generation: 2,
            rowSelection: "second folder",
            keys: ["two", "three"],
            resume: installed,
        });
        const next = yield* collect(second);
        expect(next[0]).toMatchObject({
            streamId: installed.streamId,
            sequence: 2,
            previous: 1,
            kind: "patch",
            metadata: { generation: 2 },
        });
        const changes = next.flatMap((frame) => frame.changes);
        expect(changes).toEqual([
            { kind: "put", record: row("three") },
            { kind: "remove", ref: { kind: "base", objectType: "Row", key: "one" } },
        ]);
        const expected = new Map([row("two"), row("three")].map((record) => [record.key, record]));
        const observed = new Map(
            initial
                .flatMap((frame) => frame.changes)
                .flatMap((change) =>
                    change.kind === "put" && change.record.kind === "base"
                        ? [[change.record.key, change.record] as const]
                        : []
                )
        );
        for (const change of changes) {
            if (change.kind === "put" && change.record.kind === "base")
                observed.set(change.record.key, change.record);
            if (change.kind === "remove" && "key" in change.ref) observed.delete(change.ref.key);
        }
        expect(observed).toEqual(expected);
        yield* second.acknowledge(next.at(-1)!);
    })
);

it.effect("a query change cannot reuse an uninstalled target", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const manager = yield* makeDeliveryManager({ tables, namespace: "query-uninstalled" });
        const first = yield* openView(manager, {
            generation: 1,
            rowSelection: "first folder",
            keys: ["one", "two"],
        });
        const initial = yield* collect(first);
        const second = yield* openView(manager, {
            generation: 2,
            rowSelection: "second folder",
            keys: ["two", "three"],
            resume: { streamId: initial[0]!.streamId, sequence: 0 },
        });
        const next = yield* collect(second);
        expect(next[0]).toMatchObject({ kind: "snapshot", sequence: 1, previous: 0 });
        expect(next[0]!.streamId).not.toBe(initial[0]!.streamId);
        expect(next.flatMap((frame) => frame.changes)).toEqual([
            { kind: "put", record: row("two") },
            { kind: "put", record: row("three") },
        ]);
        yield* second.acknowledge(next.at(-1)!);
    })
);

it.effect("query reuse never crosses the authenticated binding or retires its source view", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const manager = yield* makeDeliveryManager({ tables, namespace: "query-binding" });
        const first = yield* openView(manager, {
            generation: 1,
            rowSelection: "first query",
            keys: ["one"],
        });
        const initial = yield* collect(first);
        const installed = initial.at(-1)!;
        expect(
            yield* Effect.result(
                openView(manager, {
                    generation: 2,
                    rowSelection: "other query",
                    keys: ["one"],
                    resume: installed,
                    binding: "another caller",
                })
            )
        ).toMatchObject({ _tag: "Failure", failure: { kind: "HistoryExpired" } });
        const sessions = Table.make({ name: JSON.stringify(["query-binding", "delivery", "sessions"]) });
        expect(yield* tables.query(sessions)).toHaveLength(1);
        const second = yield* openView(manager, {
            generation: 2,
            rowSelection: "equivalent query",
            keys: ["one"],
            resume: installed,
        });
        const next = yield* collect(second);
        expect(next[0]).toMatchObject({ streamId: installed.streamId, kind: "patch", changes: [] });
        yield* second.acknowledge(next.at(-1)!);
    })
);

it.effect("committed query sources can reuse an installed target without a row-selection hint", () =>
    Effect.gen(function* () {
        const tables = yield* Memory.make();
        const manager = yield* makeDeliveryManager({ tables, namespace: "committed-query-reuse" });
        let generation = 1;
        const options: Omit<DeliveryOpenOptions, "identity"> = {
            binding: "source",
            changes: Effect.succeed(Stream.never),
            capture: (_tx, emit) =>
                emit(row("one")).pipe(
                    Effect.as({
                        sourceId: "source",
                        schemaHash: "schema",
                        revision: generation,
                        generation,
                        coverage: [],
                    })
                ),
        };
        const first = yield* manager.open({ ...options, identity: "first query" });
        const initial = yield* collect(first);
        generation++;
        const second = yield* manager.open({
            ...options,
            identity: "equivalent query",
            resume: initial.at(-1)!,
        });
        const next = yield* collect(second);
        expect(next[0]).toMatchObject({
            streamId: initial[0]!.streamId,
            kind: "patch",
            previous: 1,
            sequence: 2,
            changes: [],
            metadata: { generation: 2 },
        });
        yield* second.acknowledge(next.at(-1)!);
    })
);
