import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { make as current } from "../lib/memory/tables.js";
import { Table, eq, field, gte } from "../lib/table-api.js";

// An optional captured baseline factory must use the same shared Tables library.
const make = process.env.PARTY_MEMORY_BASELINE
    ? (await import(pathToFileURL(process.env.PARTY_MEMORY_BASELINE).href)).make
    : current;
const size = Number(process.env.PARTY_MEMORY_ROWS ?? 100000);
if (!Number.isSafeInteger(size) || size < 10000) throw new Error("PARTY_MEMORY_ROWS must be at least 10000.");
const records = Array.from({ length: size }, (_, n) => ({
    key: `key-${String(n).padStart(8, "0")}`,
    value: { n, group: n % 100, label: `Synthetic ${n}` },
}));
const tables = await Effect.runPromise(make());
const table = Table.make({ name: "cow-benchmark" });
for (const name of ["n", "group"])
    await Effect.runPromise(tables.ensureIndex(table, { name, field: field(name) }));
const collect = () => {
    globalThis.gc?.();
    globalThis.gc?.();
    return process.memoryUsage().heapUsed;
};
const heapBefore = collect();
const started = performance.now();
await Effect.runPromise(tables.putMany(table, records));
const populateMs = performance.now() - started;
const heapAfterPopulate = collect();
const editMs = [];
for (let n = 0; n < 21; n++) {
    const at = performance.now();
    await Effect.runPromise(
        tables.put(table, records[Math.floor(size / 2)].key, {
            n: size + n,
            group: 101 + n,
            label: `Edited ${n}`,
        })
    );
    editMs.push(performance.now() - at);
}
const median = (times) => {
    const sorted = times.slice(1).sort((a, b) => a - b);
    return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2;
};
const reads = {};
for (const name of ["indexed-range", "equality-window", "primary-keys"]) {
    const times = [];
    for (let round = 0; round < 11; round++) {
        const at = performance.now();
        const rows = await Effect.runPromise(
            name === "primary-keys"
                ? tables.keys(table, { after: records[Math.floor(size / 2)].key, limit: 51 })
                : tables.query(
                      table,
                      name === "indexed-range"
                          ? {
                                where: gte(field("n"), Math.floor(size / 2)),
                                orderBy: [{ field: field("n") }],
                                limit: 51,
                            }
                          : { where: eq(field("group"), 50), limit: 51 }
                  )
        );
        times.push(performance.now() - at);
        if (rows.length !== 51) throw new Error(`Unexpected window length: ${name}`);
    }
    reads[name] = { medianMs: median(times), times };
}
const heapAfterEdits = collect();
if ((await Effect.runPromise(tables.get(table, records[Math.floor(size / 2)].key))).n !== size + 20)
    throw new Error("Edit result mismatch.");
console.log(
    JSON.stringify(
        {
            node: process.version,
            baseline: process.env.PARTY_MEMORY_BASELINE ?? null,
            size,
            indexes: 2,
            populateMs,
            editMedianMs: median(editMs),
            editMs,
            reads,
            heap: {
                gcExposed: !!globalThis.gc,
                before: heapBefore,
                afterPopulate: heapAfterPopulate,
                afterEdits: heapAfterEdits,
                populateDelta: heapAfterPopulate - heapBefore,
                finalDelta: heapAfterEdits - heapBefore,
            },
        },
        null,
        2
    )
);
