import { Table, eq, field } from "@party-stack/ontology-storage/tables";
import { Effect, Exit } from "effect";
import { expect, vi } from "vitest";
import { make } from "../tables.js";

export const checkUniqueBulkPipeline = () =>
    Effect.scoped(
        Effect.gen(function* () {
            const tables = yield* make({ databaseName: crypto.randomUUID() });
            const table = Table.make<{ email: string; name: string; tags: string[] }>({
                name: "unique-bulk",
            });
            yield* tables.ensureIndex(table, { name: "email", field: field("email"), unique: true });
            yield* tables.ensureIndex(table, { name: "name", field: field("name"), unique: true });
            yield* tables.ensureIndex(table, { name: "tags", field: field("tags"), multiEntry: true });
            const rows = Array.from({ length: 260 }, (_, key) => ({
                key: String(key),
                value: { email: `${key}@example.test`, name: `Name ${key}`, tags: ["shared", String(key)] },
            }));
            const nativeGet = IDBObjectStore.prototype.get;
            const nativeGetAll = IDBObjectStore.prototype.getAll;
            const nativePut = IDBObjectStore.prototype.put;
            const gets = vi.spyOn(IDBObjectStore.prototype, "get");
            const probes = vi.spyOn(IDBObjectStore.prototype, "getAll");
            const puts = vi.spyOn(IDBObjectStore.prototype, "put");
            let rowReads = 0,
                uniqueReads = 0,
                activeReads = 0,
                peakReads = 0,
                activeWrites = 0,
                peakWrites = 0;
            gets.mockImplementation(function (this: IDBObjectStore, ...args) {
                if (this.name === "rows" && Array.isArray(args[0]) && args[0][0] === table.name) rowReads++;
                return Reflect.apply(nativeGet, this, args);
            });
            probes.mockImplementation(function (this: IDBObjectStore, ...args) {
                const request = Reflect.apply(nativeGetAll, this, args);
                const range = args[0] as IDBKeyRange | undefined;
                if (
                    this.name === "entries" &&
                    Array.isArray(range?.lower) &&
                    range.lower[0] === table.name &&
                    ["email", "name"].includes(range.lower[1])
                ) {
                    uniqueReads++;
                    peakReads = Math.max(peakReads, ++activeReads);
                    const done = () => {
                        activeReads--;
                    };
                    request.addEventListener("success", done, { once: true });
                    request.addEventListener("error", done, { once: true });
                }
                return request;
            });
            puts.mockImplementation(function (this: IDBObjectStore, ...args) {
                const request = Reflect.apply(nativePut, this, args);
                if (this.name === "rows" && args[0].table === table.name) {
                    peakWrites = Math.max(peakWrites, ++activeWrites);
                    const done = () => {
                        activeWrites--;
                    };
                    request.addEventListener("success", done, { once: true });
                    request.addEventListener("error", done, { once: true });
                }
                return request;
            });
            try {
                yield* tables.transaction((tx) =>
                    Effect.gen(function* () {
                        yield* tx.putMany(table, rows);
                        expect(rowReads).toBe(rows.length);
                        expect(uniqueReads).toBe(rows.length * 2);
                        expect(peakReads).toBeGreaterThan(1);
                        expect(peakReads).toBeLessThanOrEqual(128);
                        expect(peakWrites).toBeGreaterThan(1);
                        expect(peakWrites).toBeLessThanOrEqual(128);
                        expect(activeReads).toBe(0);
                        expect(activeWrites).toBe(0);
                        expect(yield* tx.get(table, "259")).toEqual(rows[259]!.value);
                    })
                );
            } finally {
                gets.mockRestore();
                probes.mockRestore();
                puts.mockRestore();
            }
            expect(yield* tables.query(table, { where: eq(field("email"), "259@example.test") })).toEqual([
                rows[259],
            ]);
            const failed = yield* Effect.exit(
                tables.transaction((tx) =>
                    tx
                        .putMany(table, [
                            {
                                key: "rollback-a",
                                value: { email: "a@rollback.test", name: "Rollback A", tags: [] },
                            },
                            {
                                key: "rollback-b",
                                value: { email: "b@rollback.test", name: "Rollback B", tags: [] },
                            },
                        ])
                        .pipe(Effect.andThen(Effect.fail("rollback bulk")))
                )
            );
            expect(Exit.isFailure(failed)).toBe(true);
            expect(yield* tables.get(table, "rollback-a")).toBeUndefined();
            expect(yield* tables.get(table, "rollback-b")).toBeUndefined();
        })
    );
