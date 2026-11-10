import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { contains, eq, field, ilike, Table } from "@party-stack/ontology-storage/tables";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { expect, vi } from "vitest";
import { make } from "../tables.js";

export const checkRequestLifetime = () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* make({ databaseName: crypto.randomUUID() });
            const rows = Table.make<number>({ name: "request-lifetime" });
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    for (let i = 0; i < 200; i++) yield* tx.put(rows, i, i);
                })
            );
            const nativeGet = IDBObjectStore.prototype.get;
            const reads = vi.spyOn(IDBObjectStore.prototype, "get");
            try {
                yield* tables.read((tx) =>
                    Effect.gen(function* () {
                        for (let i = 0; i < 200; i++) expect(yield* tx.get(rows, i)).toBe(i);
                    })
                );
                const sentinels = reads.mock.calls.filter(
                    ([key]) => Array.isArray(key) && key[0] === "" && key[1] === ""
                ).length;
                // Automatic scheduler yields may need a sentinel; ordinary native
                // request continuations must not each require an additional read.
                expect(sentinels).toBeLessThan(100);
                let active = 0;
                let peak = 0;
                reads.mockImplementation(function (this: IDBObjectStore, ...args) {
                    const request = Reflect.apply(nativeGet, this, args);
                    if (this.name === "rows" && Array.isArray(args[0]) && args[0][0] === rows.name) {
                        active++;
                        peak = Math.max(peak, active);
                        request.addEventListener("success", () => active--, { once: true });
                    }
                    return request;
                });
                const keys = Array.from({ length: 200 }, (_, i) => i);
                expect(yield* tables.getMany(rows, keys)).toEqual(keys.map((key) => ({ key, value: key })));
                expect(peak).toBeGreaterThan(1);
                expect(peak).toBeLessThanOrEqual(128);
                expect(active).toBe(0);
            } finally {
                reads.mockRestore();
            }
            const indexed = Table.make<{ name: string; tags: string[] }>({ name: "batched-indexes" });
            yield* tables.ensureIndex(indexed, { name: "name", field: field("name"), unique: true });
            yield* tables.ensureIndex(indexed, { name: "tags", field: field("tags"), multiEntry: true });
            const nativePut = IDBObjectStore.prototype.put;
            const puts = vi.spyOn(IDBObjectStore.prototype, "put");
            let active = 0;
            let peak = 0;
            let rowActive = 0;
            let rowPeak = 0;
            puts.mockImplementation(function (this: IDBObjectStore, ...args) {
                const request = Reflect.apply(nativePut, this, args);
                if (this.name === "entries") {
                    active++;
                    peak = Math.max(peak, active);
                    const finished = () => {
                        active--;
                    };
                    request.addEventListener("success", finished, { once: true });
                    request.addEventListener("error", finished, { once: true });
                }
                if (this.name === "rows" && args[0].table === rows.name) {
                    rowActive++;
                    rowPeak = Math.max(rowPeak, rowActive);
                    request.addEventListener("success", () => rowActive--, { once: true });
                }
                return request;
            });
            try {
                yield* tables.put(indexed, "one", { name: "First", tags: ["old", "old"] });
                yield* tables.put(indexed, "one", { name: "FIRST", tags: ["new"] });
                expect(peak).toBeGreaterThan(1);
                expect(active).toBe(0);
                yield* tables.putMany(
                    rows,
                    Array.from({ length: 200 }, (_, key) => ({ key, value: key }))
                );
                expect(rowPeak).toBeGreaterThan(1);
                expect(rowPeak).toBeLessThanOrEqual(128);
                expect(rowActive).toBe(0);
            } finally {
                puts.mockRestore();
            }
            expect(yield* tables.query(indexed, { where: eq(field("name"), "First") })).toEqual([]);
            expect(yield* tables.query(indexed, { where: ilike(field("name"), "first") })).toHaveLength(1);
            expect(yield* tables.query(indexed, { where: contains(field("tags"), "old") })).toEqual([]);
            expect(yield* tables.query(indexed, { where: contains(field("tags"), "new") })).toHaveLength(1);
            const entered = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            const writing = yield* Effect.forkChild(
                tables
                    .transaction((tx) =>
                        Effect.gen(function* () {
                            yield* tx.put(rows, "before", 1);
                            yield* Deferred.succeed(entered, undefined);
                            yield* Deferred.await(resume);
                            yield* Effect.yieldNow;
                            yield* Effect.sleep(5);
                            yield* tx.put(rows, "after", 2);
                            return yield* Effect.fail("rollback after asynchronous suspension");
                        })
                    )
                    .pipe(Effect.exit)
            );
            yield* Deferred.await(entered);
            yield* Effect.sleep(5);
            yield* Deferred.succeed(resume, undefined);
            expect(Exit.isFailure(yield* Fiber.join(writing))).toBe(true);
            expect(yield* tables.get(rows, "before")).toBeUndefined();
            expect(yield* tables.get(rows, "after")).toBeUndefined();
            const waiting = yield* Deferred.make<void>();
            const interrupted = yield* Effect.forkChild(
                tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.put(rows, "interrupted", 4);
                        yield* Deferred.succeed(waiting, undefined);
                        yield* Effect.never;
                    })
                )
            );
            yield* Deferred.await(waiting);
            yield* Fiber.interrupt(interrupted);
            expect(yield* tables.get(rows, "interrupted")).toBeUndefined();
            yield* tables.transaction((tx) =>
                Effect.gen(function* () {
                    yield* tx.put(rows, "committed", 3);
                    yield* Effect.sleep(5);
                    expect(yield* tx.get(rows, "committed")).toBe(3);
                })
            );
            expect(yield* tables.get(rows, "committed")).toBe(3);
        })
    );

export const requestPlatform = () => IndexedDb.make({ indexedDB, IDBKeyRange });
