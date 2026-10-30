import { Effect } from "effect";
import { queryError, codecError } from "../errors.js";
import { OntologyStorageError, type Key, type Query, type Row, type ReadTable } from "../model.js";
import {
    afterCursor,
    applyQuery,
    decodeKey,
    keyCode,
    matches,
    sameField,
    scalarKey,
} from "../query/evaluate.js";
import { selectPlan, executePlan, estimatePlan, orderedRange, emptyRange } from "./plan.js";
import type { DriverTransaction, Range, StoredIndex, StoredRow } from "../driver/index.js";
const attempt = <A>(operation: string, body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.try({ try: body, catch: (cause) => queryError(operation, cause) });
const codec = <A>(direction: "encode" | "decode", body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.try({ try: body, catch: (cause) => codecError(direction, cause) });
/** Candidate planning for stores with ordered index entry access. SQL uses its engine planner. */
export const queryRows = Effect.fnUntraced(function* <A>(
    raw: DriverTransaction,
    table: ReadTable<A>,
    indexes: readonly StoredIndex[],
    query: Query
): Effect.fn.Return<readonly StoredRow[], OntologyStorageError> {
    const originals = new Map<Key, StoredRow>();
    const finish = (rows: readonly Row<A>[]) => rows.map((row) => originals.get(row.key)!);
    const plan = yield* attempt("plan", () => selectPlan(indexes, query.where));
    if (plan?.kind === "none") return [];
    const order = query.orderBy?.length === 1 ? query.orderBy[0] : undefined;
    // Native scalar keys distinguish null and undefined. An explicit combined
    // nullish group must be sorted by the residual evaluator before limiting.
    let ordered =
        order && !order.nulls
            ? indexes.find((i) => !i.multiEntry && sameField(i.field, order.field))
            : undefined;
    if (
        ordered &&
        plan &&
        !orderedRange(plan, ordered.name) &&
        (yield* estimatePlan(raw, table.name, plan)) <= 128
    )
        ordered = undefined;
    if (ordered && query.limit !== undefined) {
        const selected: Row<A>[] = [];
        const desc = order?.direction === "desc";
        let bounds = orderedRange(plan, ordered.name) ?? {};
        let after: Range["after"];
        if (query.after) {
            const value = scalarKey(query.after.values[0]);
            if (desc) {
                // Reverse physical cursors reverse key ties, too. Read the
                // whole boundary group and restore ascending key order below.
                if (bounds.upper === undefined || value < bounds.upper)
                    bounds = { ...bounds, upper: value, upperOpen: false };
            } else {
                if (
                    bounds.upper !== undefined &&
                    (value > bounds.upper || (value === bounds.upper && bounds.upperOpen))
                )
                    return [];
                if (
                    bounds.lower === undefined ||
                    value > bounds.lower ||
                    (value === bounds.lower && !bounds.lowerOpen)
                )
                    after = { value, key: keyCode(query.after.key) };
            }
        }
        if (emptyRange(bounds)) return [];
        const needed = (query.offset ?? 0) + query.limit;
        let boundary: string | undefined;
        let finished = false;
        while (!finished) {
            const batchSize =
                desc && selected.length < needed ? Math.min(64, needed - selected.length + 1) : 64;
            const entries = yield* raw.entries(table.name, ordered.name, {
                ...bounds,
                direction: desc ? "desc" : "asc",
                limit: batchSize,
                after,
            });
            for (const entry of entries) {
                if (desc && selected.length >= needed && entry.value !== boundary) {
                    finished = true;
                    break;
                }
                const stored = yield* raw.get(table.name, entry.key);
                if (!stored) continue;
                const value = yield* codec("decode", () => table.decode(stored.data));
                const row = { key: decodeKey(entry.key), value };
                if (yield* attempt("query", () => matches(value, query.where) && afterCursor(row, query))) {
                    originals.set(row.key, stored);
                    selected.push(row);
                    if (selected.length >= needed) {
                        boundary = entry.value;
                        if (!desc) {
                            finished = true;
                            break;
                        }
                    }
                }
            }
            if (entries.length < batchSize) break;
            const last = entries.at(-1)!;
            after = { value: last.value, key: last.key };
        }
        return yield* attempt("query", () => finish(applyQuery(selected, query)));
    }
    const keys = plan ? yield* executePlan(raw, table.name, plan) : undefined;
    const stored: StoredRow[] = [];
    if (keys) {
        const ids = [...keys];
        for (let offset = 0; offset < ids.length; offset += 128) {
            const batch = yield* Effect.all(
                ids.slice(offset, offset + 128).map((key) => raw.get(table.name, key)),
                { concurrency: 128 }
            );
            for (const row of batch) if (row) stored.push(row);
        }
    } else stored.push(...(yield* raw.rows(table.name)));
    const decoded = yield* codec("decode", () =>
        stored.map((row) => {
            const key = decodeKey(row.key);
            originals.set(key, row);
            return { key, value: table.decode(row.data) };
        })
    );
    return yield* attempt("query", () => finish(applyQuery(decoded, query)));
});

export { selectPlan, executePlan, estimatePlan, orderedRange } from "./plan.js";
