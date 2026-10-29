import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Layer, Scope } from "effect";
import { expect, test } from "vite-plus/test";
import { MemoryBlobBytesStore } from "./memory/MemoryBlobBytesStore.js";
import { Runtime } from "./Runtime.js";
import { RuntimePartition } from "./RuntimePartition.js";
import { Runtimes } from "./Runtimes.js";

test("partition Layers isolate resources, share active acquisitions, and release the final lease", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const platform = Layer.effect(
        Runtime,
        Effect.gen(function* () {
            const partition = yield* RuntimePartition;
            yield* Effect.acquireRelease(
                Effect.sync(() => opened.push(partition.namespace)),
                () =>
                    Effect.sync(() => {
                        closed.push(partition.namespace);
                    })
            );
            return yield* Runtime.make({ blobBytes: new MemoryBlobBytesStore() }).pipe(
                Effect.provideService(RuntimePartition, {
                    ...partition,
                    namespace: `version:${partition.namespace}`,
                })
            );
        })
    );
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const registry = yield* Runtimes;
                const firstScope = yield* Scope.fork(yield* Effect.scope);
                const secondScope = yield* Scope.fork(yield* Effect.scope);
                const first = yield* Scope.provide(
                    registry.acquire({ owner: "user", namespace: "first" }),
                    firstScope
                );
                const same = yield* Scope.provide(
                    registry.acquire({ owner: "user", namespace: "first" }),
                    secondScope
                );
                expect(same).toBe(first);
                const other = yield* registry.acquire({ owner: "user", namespace: "second" });
                expect(other).not.toBe(first);
                expect(other.namespace).toBe("version:second");
                expect(first.namespace).toBe("version:first");
                const rows = Table.make<number>({ name: "rows" });
                yield* first.tables.put(rows, "one", 1);
                expect(yield* other.tables.get(rows, "one")).toBeUndefined();
                expect(opened).toEqual(["first", "second"]);
                yield* Scope.close(firstScope, Exit.void);
                expect(closed).toEqual([]);
                yield* Scope.close(secondScope, Exit.void);
                expect(closed).toEqual(["first"]);
            })
        ).pipe(Effect.provide(Runtimes.layer(platform)))
    );
    expect(closed).toEqual(["first", "second"]);
});
