import { Effect } from "effect";
import { codecError, queryError } from "../errors.js";
import {
    afterCursor,
    compareRows,
    decodeKey,
    keyCode,
    matches,
    sameField,
    scalarKey,
} from "../query/evaluate.js";
import { emptyRange, estimatePlan, INDEX_BATCH_SIZE, orderedRange } from "./plan.js";
import type { DriverQueryResult, DriverTransaction, Range, StoredIndex, StoredRow } from "../driver/index.js";
import type { Entry } from "../driver/index.js";
import type { OntologyStorageError, Order, Query, ReadTable, Row } from "../model.js";
import type { Plan } from "./plan.js";

const attempt = <A>(body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.try({ try: body, catch: (cause) => queryError("query", cause) });
const decode = <A>(body: () => A): Effect.Effect<A, OntologyStorageError> =>
    Effect.try({ try: body, catch: (cause) => codecError("decode", cause) });

/** Bounds remain inclusive at a cursor's leading value: trailing fields and
 * the query's ascending primary-key suffix still decide order within that tie.
 */
function intersect(a: Range, b: Range): Range {
    let lower = a.lower,
        lowerOpen = !!a.lowerOpen;
    if (lower === undefined || (b.lower !== undefined && b.lower > lower)) {
        lower = b.lower;
        lowerOpen = !!b.lowerOpen;
    } else if (b.lower === lower) lowerOpen ||= !!b.lowerOpen;
    let upper = a.upper,
        upperOpen = !!a.upperOpen;
    if (upper === undefined || (b.upper !== undefined && b.upper < upper)) {
        upper = b.upper;
        upperOpen = !!b.upperOpen;
    } else if (b.upper === upper) upperOpen ||= !!b.upperOpen;
    return { lower, lowerOpen, upper, upperOpen };
}
function scanSegments(first: Order, query: Query, bounds: Range = {}) {
    const direction = first.direction ?? "asc";
    let segments: { nullish: boolean; range: Range }[] = first.nulls
        ? [
              { nullish: true, range: { lower: "0", upper: "1" } },
              { nullish: false, range: { lower: "1", lowerOpen: true } },
          ]
        : [{ nullish: false, range: {} }];
    if (first.nulls === "last") segments.reverse();
    if (query.after) {
        const cursorValue = query.after.values[0],
            cursorNullish = cursorValue == null;
        segments = segments.filter((segment) => {
            if (!first.nulls) return true;
            if (segment.nullish) return cursorNullish || first.nulls === "last";
            return !cursorNullish || first.nulls === "first";
        });
        const cursorBound: Range =
            direction === "desc" ? { upper: scalarKey(cursorValue) } : { lower: scalarKey(cursorValue) };
        segments = segments.map((segment) => ({
            ...segment,
            range:
                !first.nulls || (!segment.nullish && !cursorNullish)
                    ? intersect(segment.range, cursorBound)
                    : segment.range,
        }));
    }
    return segments
        .map((segment) => ({ ...segment, range: { ...intersect(segment.range, bounds), direction } }))
        .filter((segment) => !emptyRange(segment.range));
}

/** One scalar order always has the ascending storage-key suffix. Descending
 * physical cursors reverse that suffix too, so reorder complete metadata groups
 * locally and read an incomplete boundary bucket in ascending key order.
 */
export const scalarWindow = Effect.fnUntraced(function* <A>(
    raw: DriverTransaction,
    table: ReadTable<A>,
    indexes: readonly StoredIndex[],
    query: Query,
    plan: Plan | undefined
): Effect.fn.Return<DriverQueryResult<A> | undefined, OntologyStorageError> {
    if (query.orderBy?.length !== 1 || query.limit === undefined) return undefined;
    const order = query.orderBy[0]!,
        limit = query.limit;
    const index = indexes.find((index) => !index.multiEntry && sameField(index.field, order.field));
    if (!index) return undefined;
    const bounds = orderedRange(plan, index.name);
    if (plan && !bounds && (yield* estimatePlan(raw, table.name, plan)) <= INDEX_BATCH_SIZE) return undefined;
    const segments = yield* attempt(() => scanSegments(order, query, bounds));
    const selected: StoredRow[] = [],
        decodedRows: Row<A>[] = [];
    let skipped = 0;
    const needed = () => (query.offset ?? 0) - skipped + limit - selected.length;
    const finish = (): DriverQueryResult<A> => ({ rows: selected, decodedRows, complete: true });
    const cursorValue = query.after ? scalarKey(query.after.values[0]) : undefined;
    const cursorKey = query.after ? keyCode(query.after.key) : undefined;
    const consume = Effect.fnUntraced(function* (entries: readonly Entry[]) {
        let offset = 0;
        while (offset < entries.length && selected.length < limit) {
            const batch = entries.slice(offset, offset + Math.min(INDEX_BATCH_SIZE, needed()));
            const stored = yield* Effect.forEach(batch, (entry) => raw.get(table.name, entry.key), {
                concurrency: INDEX_BATCH_SIZE,
            });
            const rows = yield* decode(() =>
                stored.map((row) =>
                    row
                        ? { stored: row, row: { key: decodeKey(row.key), value: table.decode(row.data) } }
                        : undefined
                )
            );
            for (const item of rows) {
                if (
                    !item ||
                    !(yield* attempt(
                        () => matches(item.row.value, query.where) && afterCursor(item.row, query)
                    ))
                )
                    continue;
                if (skipped < (query.offset ?? 0)) skipped++;
                else {
                    selected.push(item.stored);
                    decodedRows.push(item.row);
                }
            }
            offset += batch.length;
        }
        return selected.length === limit;
    });
    const afterEntries = (entries: readonly Entry[]) =>
        cursorKey === undefined
            ? entries
            : entries.filter((entry) => entry.value !== cursorValue || entry.key > cursorKey);
    for (const segment of segments) {
        if (segment.nullish) {
            // Null and undefined form one logical group. Their two physical
            // indexes cannot be concatenated in the query's key order.
            if ((yield* raw.entries(table.name, index.name, { ...segment.range, limit: 1 })).length)
                return undefined;
            continue;
        }
        if (order.direction !== "desc") {
            let after: Range["after"] =
                query.after && segment.range.lower === cursorValue && !segment.range.lowerOpen
                    ? { value: cursorValue!, key: cursorKey! }
                    : undefined;
            for (;;) {
                const size = Math.min(INDEX_BATCH_SIZE, needed());
                const entries = yield* raw.entries(table.name, index.name, {
                    ...segment.range,
                    after,
                    limit: size,
                });
                if (yield* consume(entries)) return finish();
                if (entries.length < size) break;
                const last = entries.at(-1)!;
                after = { value: last.value, key: last.key };
            }
            continue;
        }
        let remaining = segment.range;
        for (;;) {
            const entries = yield* raw.entries(table.name, index.name, {
                ...remaining,
                limit: INDEX_BATCH_SIZE,
            });
            if (!entries.length) break;
            const tail = entries.at(-1)!.value;
            let complete = entries.length;
            if (entries.length === INDEX_BATCH_SIZE)
                while (complete > 0 && entries[complete - 1]!.value === tail) complete--;
            const ordered: Entry[] = [];
            let start = 0;
            while (start < complete) {
                let end = start + 1;
                while (end < complete && entries[end]!.value === entries[start]!.value) end++;
                ordered.push(
                    ...entries.slice(start, end).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
                );
                start = end;
            }
            if (yield* consume(afterEntries(ordered))) return finish();
            if (complete === entries.length) break;
            // The last physical group may continue beyond the leading page.
            // Scan its exact value ASC so an arbitrarily large tie stays bounded.
            const bucket = intersect(remaining, { lower: tail, upper: tail });
            let after: Range["after"] = tail === cursorValue ? { value: tail, key: cursorKey! } : undefined;
            for (;;) {
                const size = Math.min(INDEX_BATCH_SIZE, needed());
                const group = yield* raw.entries(table.name, index.name, {
                    ...bucket,
                    direction: "asc",
                    after,
                    limit: size,
                });
                if (yield* consume(group)) return finish();
                if (group.length < size) break;
                const last = group.at(-1)!;
                after = { value: last.value, key: last.key };
            }
            remaining = { ...intersect(remaining, { upper: tail, upperOpen: true }), direction: "desc" };
            if (emptyRange(remaining)) break;
        }
    }
    return finish();
});

/** A complete leading-value tie is sufficient to decide the next sorted window.
 * Secondary values use the ordinary evaluator, so they need not have indexes.
 * Undefined declines when tiny candidates or a broad indexed tie favor the
 * existing candidate/map plan instead of hydrating a large group of rows.
 */
export const orderedWindow = Effect.fnUntraced(function* <A>(
    raw: DriverTransaction,
    table: ReadTable<A>,
    indexes: readonly StoredIndex[],
    query: Query,
    plan: Plan | undefined
): Effect.fn.Return<DriverQueryResult<A> | undefined, OntologyStorageError> {
    const orders = query.orderBy;
    if (!orders?.length || query.limit === undefined || (orders.length === 1 && !orders[0]!.nulls))
        return undefined;
    const limit = query.limit;
    const first = orders[0]!;
    const index = indexes.find((index) => !index.multiEntry && sameField(index.field, first.field));
    if (!index) return undefined;
    if (plan && (yield* estimatePlan(raw, table.name, plan)) <= INDEX_BATCH_SIZE) return undefined;
    const segments = yield* attempt(() => scanSegments(first, query, orderedRange(plan, index.name)));
    const indexedOrder = orders.every((order) =>
        indexes.some((index) => !index.multiEntry && sameField(index.field, order.field))
    );
    if (indexedOrder) {
        for (const segment of segments) {
            const entries = yield* raw.entries(table.name, index.name, { ...segment.range, limit: 1 });
            if (!entries.length) continue;
            const range = segment.nullish
                ? segment.range
                : intersect(segment.range, { lower: entries[0]!.value, upper: entries[0]!.value });
            // This is a conservative cost choice, not a completeness condition.
            // Maps avoid boundary-tie overhydration across paginated windows.
            if ((yield* raw.countEntries(table.name, index.name, range)) > 1) return undefined;
            break;
        }
    }
    interface Item {
        readonly stored: StoredRow;
        readonly row: Row<A>;
    }
    const selected: Item[] = [];
    let skipped = 0;
    let group: Item[] = [];
    const flush = () => {
        group.sort((a, b) => compareRows(a.row, b.row, query));
        for (const item of group) {
            if (skipped < (query.offset ?? 0)) skipped++;
            else if (selected.length < limit) selected.push(item);
            else break;
        }
        group = [];
        return selected.length === limit;
    };
    const finish = (): DriverQueryResult<A> => ({
        rows: selected.map((item) => item.stored),
        decodedRows: selected.map((item) => item.row),
        complete: true,
    });
    for (const segment of segments) {
        let after: Range["after"];
        let groupValue: string | undefined;
        let groupEntries = 0;
        for (;;) {
            const entries = yield* raw.entries(table.name, index.name, {
                ...segment.range,
                after,
                limit: INDEX_BATCH_SIZE,
            });
            if (!entries.length) break;
            if (indexedOrder) {
                let previous = groupValue;
                // Any tie in this minimum required prefix must be visited even
                // if every residual matches. Decline before hydrating that page.
                const needed = Math.max(
                    1,
                    (query.offset ?? 0) - skipped + limit - selected.length - group.length
                );
                for (let i = 0; i < Math.min(entries.length, needed); i++) {
                    const value = segment.nullish ? "nullish" : entries[i]!.value;
                    if (value === previous) return undefined;
                    previous = value;
                }
            }
            const stored = yield* Effect.forEach(entries, (entry) => raw.get(table.name, entry.key), {
                concurrency: INDEX_BATCH_SIZE,
            });
            const values = yield* decode(() =>
                stored.map((value): Item | undefined =>
                    value
                        ? {
                              stored: value,
                              row: { key: decodeKey(value.key), value: table.decode(value.data) },
                          }
                        : undefined
                )
            );
            const progress = yield* attempt(() => {
                for (let i = 0; i < entries.length; i++) {
                    const value = segment.nullish ? "nullish" : entries[i]!.value;
                    if (value !== groupValue) {
                        if (groupValue !== undefined && flush()) return "complete";
                        groupEntries = 0;
                    }
                    groupValue = value;
                    // Residuals may make a later tie necessary only after this
                    // bounded page was decoded. Do not hydrate its whole group.
                    if (indexedOrder && ++groupEntries > 1) return "fallback";
                    const item = values[i];
                    if (item && matches(item.row.value, query.where) && afterCursor(item.row, query))
                        group.push(item);
                }
                return "continue";
            });
            if (progress === "complete") return finish();
            if (progress === "fallback") return undefined;
            if (entries.length < INDEX_BATCH_SIZE) break;
            const last = entries.at(-1)!;
            after = { value: last.value, key: last.key };
        }
        if (yield* attempt(flush)) return finish();
    }
    return finish();
});
