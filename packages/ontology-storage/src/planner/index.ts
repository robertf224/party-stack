import { Effect } from "effect";
import { queryError, codecError } from "../errors.js";
import { OntologyStorageError, type Key, type Query, type Row, type ReadTable } from "../model.js";
import {
    applyQuery,
    decodeKey,
    keyCode,
    matches,
    sameField,
    scalarKey,
    validateQuery,
} from "../query/evaluate.js";
import { orderedWindow, scalarWindow } from "./ordered-window.js";
import { selectPlan, executePlan } from "./plan.js";
import type { DriverQueryResult, DriverTransaction, Range, StoredIndex, StoredRow } from "../driver/index.js";
import type { Plan } from "./plan.js";
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
): Effect.fn.Return<DriverQueryResult<A>, OntologyStorageError> {
    yield* attempt("query", () => validateQuery(query));
    if (query.limit === 0) return { rows: [], complete: true, decodedRows: [] };
    // Without value predicates/order, encoded row keys already define the full
    // ordering. Hydrate only the selected rows at the public table boundary;
    // decoding every value here and again there buys no query semantics.
    if (!query.where && !query.orderBy?.length) {
        const after = query.after && (yield* attempt("query", () => keyCode(query.after!.key)));
        const rows = [...(yield* raw.rows(table.name))];
        return {
            rows: rows
                .filter((row) => after === undefined || row.key > after)
                .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
                .slice(
                    query.offset ?? 0,
                    query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit
                ),
            complete: true,
        };
    }
    const originals = new Map<Key, StoredRow>();
    const finish = (rows: readonly Row<A>[]): DriverQueryResult<A> => ({
        rows: rows.map((row) => originals.get(row.key)!),
        complete: true,
        decodedRows: rows,
    });
    const plan = yield* attempt("plan", () => selectPlan(indexes, query.where));
    if (plan?.kind === "none") return { rows: [], complete: true, decodedRows: [] };
    const scalar = yield* scalarWindow(raw, table, indexes, query, plan);
    if (scalar !== undefined) return scalar;
    // Within a single equality group, an ordinary index's row-key suffix is
    // exactly the query's implicit order. Stream that group instead of rebuilding
    // and intersecting every candidate set for each delivery page. Other indexed
    // conditions remain residuals, so sparse/unknown fields never grant matches.
    if (!query.orderBy?.length && query.limit !== undefined) {
        const equality = yield* keyOrderedEquality(raw, table.name, indexes, plan);
        if (equality) {
            const selected: StoredRow[] = [];
            const decodedRows: Row<A>[] = [];
            let skipped = 0;
            let after = query.after
                ? { value: equality.range.lower!, key: keyCode(query.after.key) }
                : undefined;
            while (selected.length < query.limit) {
                const size = Math.min(128, (query.offset ?? 0) - skipped + query.limit - selected.length);
                const entries = yield* raw.entries(table.name, equality.index, {
                    ...equality.range,
                    after,
                    limit: size,
                });
                const rows = yield* Effect.forEach(entries, (entry) => raw.get(table.name, entry.key), {
                    concurrency: 128,
                });
                for (const stored of rows) {
                    if (!stored) continue;
                    const value = yield* codec("decode", () => table.decode(stored.data));
                    if (!(yield* attempt("query", () => matches(value, query.where)))) continue;
                    if (skipped < (query.offset ?? 0)) skipped++;
                    else {
                        selected.push(stored);
                        decodedRows.push({ key: decodeKey(stored.key), value });
                    }
                }
                if (entries.length < size) break;
                const last = entries.at(-1)!;
                after = { value: last.value, key: last.key };
            }
            return { rows: selected, complete: true, decodedRows };
        }
    }
    const leading = yield* orderedWindow(raw, table, indexes, query, plan);
    if (leading !== undefined) return leading;
    const keys = plan ? yield* executePlan(raw, table.name, plan) : undefined;
    const composite = yield* indexedCompositeWindow(raw, table, indexes, query, keys);
    if (composite !== undefined) return composite;
    if (keys && !query.orderBy?.length) {
        // Implicit ordering is by encoded row key. Apply its cursor before
        // hydration, then stop once enough residual matches fill the page.
        // Delivery scans page through large selections; hydrating every key
        // again for each 128-row page makes those scans quadratic.
        const after = query.after && (yield* attempt("query", () => keyCode(query.after!.key)));
        const ids = [...keys]
            .filter((key) => after === undefined || key > after)
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const selected: StoredRow[] = [];
        const decodedRows: Row<A>[] = [];
        let skipped = 0;
        for (let offset = 0; offset < ids.length; offset += 128) {
            const batch = yield* Effect.all(
                ids.slice(offset, offset + 128).map((key) => raw.get(table.name, key)),
                { concurrency: 128 }
            );
            for (const row of batch) {
                if (!row) continue;
                const value = yield* codec("decode", () => table.decode(row.data));
                if (!(yield* attempt("query", () => matches(value, query.where)))) continue;
                if (skipped < (query.offset ?? 0)) skipped++;
                else {
                    selected.push(row);
                    decodedRows.push({ key: decodeKey(row.key), value });
                }
                if (query.limit !== undefined && selected.length === query.limit)
                    return { rows: selected, complete: true, decodedRows };
            }
        }
        return { rows: selected, complete: true, decodedRows };
    }
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

/** Only a conjunctive exact value group has row-key order across its whole scan.
 * ORs, multiple IN values, ranges and multi-entry indexes keep the normal planner.
 */
const keyOrderedEquality = Effect.fnUntraced(function* (
    raw: DriverTransaction,
    table: string,
    indexes: readonly StoredIndex[],
    plan: Plan | undefined
) {
    const candidates: { index: string; range: Range }[] = [];
    const collect = (current: Plan | undefined): void => {
        if (current?.kind === "and") {
            for (const child of current.children) collect(child);
        } else if (current?.kind === "lookup" && current.ranges.length === 1) {
            const range = current.ranges[0]!;
            if (
                range.lower !== undefined &&
                range.lower === range.upper &&
                !range.lowerOpen &&
                !range.upperOpen &&
                indexes.some((index) => index.name === current.index && !index.multiEntry)
            )
                candidates.push({ index: current.index, range });
        }
    };
    collect(plan);
    let selected = candidates[0];
    if (candidates.length < 2) return selected;
    let smallest = Infinity;
    for (const candidate of candidates) {
        const count = yield* raw.countEntries(table, candidate.index, candidate.range);
        if (count < smallest) {
            smallest = count;
            selected = candidate;
        }
        if (count === 0) break;
    }
    return selected;
});

/** Existing scalar indexes can order a composite window without rehydrating
 * the entire candidate set for each page. Index maps live only for this read.
 */
const indexedCompositeWindow = Effect.fnUntraced(function* <A>(
    raw: DriverTransaction,
    table: ReadTable<A>,
    indexes: readonly StoredIndex[],
    query: Query,
    candidates: ReadonlySet<string> | undefined
): Effect.fn.Return<DriverQueryResult<A> | undefined, OntologyStorageError> {
    const orders = query.orderBy;
    if (
        !orders ||
        !orders.length ||
        (orders.length === 1 && !orders[0]!.nulls) ||
        query.limit === undefined ||
        (candidates && candidates.size <= 128)
    )
        return undefined;
    const ordered = orders.map((order) =>
        indexes.find((index) => !index.multiEntry && sameField(index.field, order.field))
    );
    if (ordered.some((index) => !index)) return undefined;
    const columns = yield* Effect.forEach(
        ordered,
        Effect.fnUntraced(function* (index) {
            const values = new Map<string, string>();
            let after: Range["after"];
            for (;;) {
                const entries = yield* raw.entries(table.name, index!.name, { after, limit: 128 });
                for (const entry of entries)
                    if (!candidates || candidates.has(entry.key)) values.set(entry.key, entry.value);
                if (entries.length < 128) break;
                const last = entries.at(-1)!;
                after = { value: last.value, key: last.key };
            }
            return values;
        }),
        { concurrency: 128 }
    );
    const keys = [...(candidates ?? columns[0]!.keys())];
    if (keys.some((key) => columns.some((column) => !column.has(key)))) return undefined;
    const compare = (left: readonly string[], right: readonly string[], a: string, b: string) => {
        for (let i = 0; i < orders.length; i++) {
            const nulls = orders[i]!.nulls;
            if (nulls) {
                const a = left[i] === "0" || left[i] === "1";
                const b = right[i] === "0" || right[i] === "1";
                if (a && b) continue;
                if (a || b) return (a ? -1 : 1) * (nulls === "first" ? 1 : -1);
            }
            const result = left[i]! < right[i]! ? -1 : left[i]! > right[i]! ? 1 : 0;
            if (result) return orders[i]!.direction === "desc" ? -result : result;
        }
        return a < b ? -1 : a > b ? 1 : 0;
    };
    const values = (key: string) => columns.map((column) => column.get(key)!);
    const after = query.after?.values.map(scalarKey);
    const afterKey = query.after ? keyCode(query.after.key) : "";
    const ids = keys
        .filter((key) => !after || compare(values(key), after, key, afterKey) > 0)
        .sort((a, b) => compare(values(a), values(b), a, b));
    const selected: StoredRow[] = [];
    const decodedRows: Row<A>[] = [];
    let skipped = 0;
    let offset = 0;
    while (offset < ids.length && selected.length < query.limit) {
        const size = Math.min(128, (query.offset ?? 0) - skipped + query.limit - selected.length);
        const batch = yield* Effect.forEach(
            ids.slice(offset, offset + size),
            (key) => raw.get(table.name, key),
            {
                concurrency: 128,
            }
        );
        offset += size;
        for (const stored of batch) {
            if (!stored) continue;
            const value = yield* codec("decode", () => table.decode(stored.data));
            if (!(yield* attempt("query", () => matches(value, query.where)))) continue;
            if (skipped < (query.offset ?? 0)) skipped++;
            else {
                selected.push(stored);
                decodedRows.push({ key: decodeKey(stored.key), value });
            }
        }
    }
    return { rows: selected, complete: true, decodedRows };
});

export { selectPlan, executePlan, estimatePlan, orderedRange } from "./plan.js";
