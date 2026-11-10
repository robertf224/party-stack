import { Effect } from "effect";
import { expect, test } from "vitest";
import * as Memory from "./memory/tables.js";
import { Table } from "./model.js";
import { tableUsage } from "./usage.js";

test("paged usage inspection agrees with stored rows across rollback, reopen and clear without write bookkeeping", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const tables = yield* Memory.make();
                const rows = Table.make<string>({ name: "objects" });
                yield* tables.put(rows, "existing", "abc");
                const counter = () => tableUsage({ tables: () => [rows] as Table<unknown>[] });
                let usage = counter();
                const oracle = () =>
                    tables
                        .query(rows)
                        .pipe(
                            Effect.map((entries) =>
                                entries.reduce(
                                    (n, row) => n + new TextEncoder().encode(rows.encode(row.value)).length,
                                    0
                                )
                            )
                        );
                expect(yield* tables.transaction(usage.total)).toBe(yield* oracle());
                yield* tables.transaction((native) => {
                    const tx = native;
                    return Effect.forEach(
                        Array.from({ length: 300 }, (_, n) => n),
                        (n) => tx.put(rows, String(n), "x".repeat(n % 31)),
                        { concurrency: 20 }
                    );
                });
                expect(yield* tables.transaction(usage.total)).toBe(yield* oracle());
                yield* Effect.result(
                    tables.transaction((native) =>
                        native.delete(rows, "existing").pipe(Effect.andThen(Effect.fail("rollback")))
                    )
                );
                usage = counter();
                expect(yield* tables.transaction(usage.total)).toBe(yield* oracle());
                yield* tables.transaction((tx) => tx.clear(rows));
                expect(yield* tables.transaction(usage.total)).toBe(0);
            })
        )
    );
});
