import { Effect } from "effect";
import { cursorOf } from "./query/evaluate.js";
import type { Table, Cursor } from "./model.js";
import type { ReadTransaction } from "./tables.js";

/** Measure logical payloads on inspection/maintenance, without adding write-side
 * counters or locks. Scans use bounded pages within the caller's read snapshot.
 */
export const tableUsage = (options: {
    readonly tables: () => readonly Table<unknown>[];
    readonly size?: (table: Table<unknown>, value: unknown) => number;
}) => {
    const size = options.size ?? ((table, value) => new TextEncoder().encode(table.encode(value)).byteLength);
    const measure = Effect.fnUntraced(function* (tx: ReadTransaction) {
        const byTable: Record<string, number> = {};
        let bytes = 0;
        for (const table of options.tables()) {
            let after: Cursor | undefined;
            let used = 0;
            for (;;) {
                const rows = yield* tx.query(table, { after, limit: 128 });
                for (const row of rows) used += size(table, row.value);
                if (rows.length < 128) break;
                after = cursorOf(rows.at(-1)!, {});
            }
            byTable[table.name] = used;
            bytes += used;
        }
        return { bytes, byTable };
    });
    return {
        measure,
        total: (tx: ReadTransaction) => measure(tx).pipe(Effect.map((result) => result.bytes)),
        size,
    };
};
