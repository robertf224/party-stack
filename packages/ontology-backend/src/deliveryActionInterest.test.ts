import { it } from "@effect/vitest";
import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Effect, Queue, Stream } from "effect";
import { expect } from "vite-plus/test";
import { makeDeliveryManager, type DeliveryFrame, type DeliveryRecord } from "./delivery.js";

it.effect(
    "new action interests replay the immutable uninstalled row target before capturing latest outcomes",
    () =>
        Effect.gen(function* () {
            const manager = yield* makeDeliveryManager({
                tables: yield* Memory.make(),
                namespace: "action-interest",
            });
            const one: DeliveryRecord = {
                kind: "base",
                objectType: "Row",
                key: "one",
                value: { id: "one", n: 1 },
            };
            const two: DeliveryRecord = {
                kind: "base",
                objectType: "Row",
                key: "two",
                value: { id: "two", n: 2 },
            };
            const action: DeliveryRecord = {
                kind: "pending",
                id: "wanted",
                value: {
                    invocation: { id: "wanted", name: "write", parameters: {} },
                    requestIdentity: "wanted",
                    createdAt: 0,
                    sequence: 1,
                    state: "queued",
                    optimistic: true,
                    attempts: 0,
                    touchedTypes: [],
                },
            };
            let captures = 0;
            const open = (
                generation: number,
                records: readonly DeliveryRecord[],
                resume?: { streamId: string; sequence: number }
            ) =>
                manager.open({
                    binding: "same caller",
                    identity: JSON.stringify({ generation, actions: generation === 1 ? [] : ["wanted"] }),
                    rowSelection: "all rows",
                    resume,
                    policy: { frameRecords: 1, maxSubscriptions: 1 },
                    changes: Effect.succeed(Stream.never),
                    capture: (_tx, emit) =>
                        Effect.gen(function* () {
                            captures++;
                            for (const record of records) yield* emit(record);
                            return {
                                sourceId: "source",
                                schemaHash: "schema",
                                generation,
                                revision: generation,
                                coverage: [],
                            };
                        }),
                });
            const first = yield* open(1, [one, two]);
            const old = yield* first.frames.pipe(
                Stream.takeUntil((frame) => frame.end),
                Stream.runCollect
            );
            expect(captures).toBe(1);
            const second = yield* open(2, [one, { ...two, value: { id: "two", n: 20 } }, action], {
                streamId: old[0]!.streamId,
                sequence: 0,
            });
            const frames = yield* Queue.unbounded<DeliveryFrame>();
            yield* second.frames.pipe(
                Stream.runForEach((frame) => Queue.offer(frames, frame)),
                Effect.forkScoped
            );
            const replay: DeliveryFrame[] = [];
            do {
                replay.push(yield* Queue.take(frames));
            } while (!replay.at(-1)!.end);
            expect(replay).toEqual(old);
            expect(captures).toBe(1);
            yield* second.acknowledge(replay.at(-1)!);
            const next: DeliveryFrame[] = [];
            do {
                next.push(yield* Queue.take(frames));
            } while (!next.at(-1)!.end);
            expect(captures).toBe(2);
            expect(next[0]).toMatchObject({
                streamId: old[0]!.streamId,
                sequence: 2,
                previous: 1,
                kind: "patch",
            });
            expect(next.at(-1)?.metadata).toMatchObject({ generation: 2, revision: 2 });
            expect(next.flatMap((frame) => frame.changes)).toEqual([
                { kind: "put", record: { ...two, value: { id: "two", n: 20 } } },
                { kind: "put", record: action },
            ]);
            yield* second.acknowledge(next.at(-1)!);
        })
);
