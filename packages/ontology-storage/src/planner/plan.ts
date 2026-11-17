import { Effect } from "effect";
import {
    sameField,
    scalarKey,
    caseInsensitiveIndex,
    fieldIndex,
    indexedComparison,
} from "../query/evaluate.js";
import { filterOperand, inValues, isComparison, lengthComparison } from "../query/filter.js";
import type { DriverTransaction, Range, StoredIndex } from "../driver/index.js";
import type { Field, Filter, OntologyStorageError } from "../model.js";
import type { ComparisonKind } from "../query/filter.js";

/** Candidate plans are supersets; the complete filter is always evaluated on hydrated rows.
 * Scalar operands use field indexes; a list's missing-value and `length` checks use its
 * size index. Anything else is evaluated on rows. */
export type Plan =
    | { readonly kind: "none" }
    | { readonly kind: "lookup"; readonly index: string; readonly ranges: readonly Range[] }
    | { readonly kind: "and" | "or"; readonly children: readonly Plan[] };
export const INDEX_BATCH_SIZE = 128;
// Storage comparisons are two-valued over a total order, so negating one flips its operator.
const negated = { eq: "ne", ne: "eq", lt: "gte", lte: "gt", gt: "lte", gte: "lt" } as const;
export function selectPlan(indexes: readonly StoredIndex[], filter?: Filter): Plan | undefined {
    if (!filter) return undefined;
    if (filter.kind === "not") {
        const inner = filter.value.expression;
        return isComparison(inner)
            ? selectPlan(indexes, { kind: negated[inner.kind], value: inner.value } as Filter)
            : undefined;
    }
    if (filter.kind === "and" || filter.kind === "or") {
        const children = filter.value.expressions.map((p) => selectPlan(indexes, p));
        if (filter.kind === "or" && children.some((p) => p === undefined)) return undefined;
        if (filter.kind === "and" && children.some((p) => p?.kind === "none")) return { kind: "none" };
        const available = children.filter((p): p is Plan => p !== undefined && p.kind !== "none");
        if (!available.length) return filter.kind === "or" ? { kind: "none" } : undefined;
        if (available.length === 1) return available[0];
        return { kind: filter.kind, children: available };
    }
    return fieldLookup(indexes, filter) ?? sizeLookup(indexes, filter);
}
function fieldLookup(indexes: readonly StoredIndex[], filter: Filter): Plan | undefined {
    if (!("left" in filter.value)) return undefined;
    const comparison = indexedComparison(filter);
    const left = filterOperand(filter.value.left);
    const right = filterOperand(filter.value.right);
    const reference =
        comparison?.field ??
        ((filter.kind === "contains" ||
            filter.kind === "in" ||
            filter.kind === "like" ||
            filter.kind === "ilike") &&
        left?.kind === "field"
            ? left.field
            : undefined);
    if (!reference || comparison?.op === "ne") return undefined;
    const index = indexes.find(
        (i) => sameField(i.field, reference) && (filter.kind === "contains" ? !!i.multiEntry : fieldIndex(i))
    );
    if (!index) return undefined;
    let ranges: Range[];
    if (filter.kind === "contains") {
        if (right?.kind !== "literal") return undefined;
        const value = scalarKey(right.value);
        ranges = [{ lower: value, upper: value }];
    } else if (filter.kind === "in") {
        ranges = [...new Set(inValues(filter).map(scalarKey))].map((value) => ({
            lower: value,
            upper: value,
        }));
    } else if (filter.kind === "like" || filter.kind === "ilike") {
        if (right?.kind !== "literal" || typeof right.value !== "string") return undefined;
        const pattern = filter.kind === "ilike" ? right.value.toLowerCase() : right.value;
        const wildcard = pattern.search(/[%_]/);
        if (wildcard === 0) return undefined;
        const lower = scalarKey(wildcard < 0 ? pattern : pattern.slice(0, wildcard));
        ranges = [wildcard < 0 ? { lower, upper: lower } : { lower, upper: `${lower}g`, upperOpen: true }];
    } else {
        if (!comparison) return undefined;
        const value = scalarKey(comparison.value);
        ranges = [
            comparison.op === "eq"
                ? { lower: value, upper: value }
                : comparison.op === "gt" || comparison.op === "gte"
                  ? { lower: value, lowerOpen: comparison.op === "gt" }
                  : { upper: value, upperOpen: comparison.op === "lt" },
        ];
    }
    return ranges.length
        ? {
              kind: "lookup",
              index: filter.kind === "ilike" ? caseInsensitiveIndex(index.name) : index.name,
              ranges,
          }
        : { kind: "none" };
}
// Size index keys: undefined, then null, then finite numbers (every number key starts with "3").
const missingKeys: Range = { lower: scalarKey(undefined), upper: scalarKey(null) };
const numberKeys = { lower: "3", upper: "4", upperOpen: true } as const;
/** Size-index ranges for `length(list) <op> n`. A missing or null list has length 0. */
export function sizeRanges(op: ComparisonKind, n: unknown): Range[] | undefined {
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
    const key = scalarKey(n);
    const below: Range = { lower: numberKeys.lower, upper: key, upperOpen: true };
    const above: Range = { lower: key, lowerOpen: true, upper: numberKeys.upper, upperOpen: true };
    const numeric: Range[] =
        op === "eq"
            ? [{ lower: key, upper: key }]
            : op === "ne"
              ? [below, above]
              : op === "lt"
                ? [below]
                : op === "lte"
                  ? [{ ...below, upperOpen: false }]
                  : op === "gt"
                    ? [above]
                    : [{ ...above, lowerOpen: false }];
    const zero =
        op === "eq"
            ? n === 0
            : op === "ne"
              ? n !== 0
              : op === "lt"
                ? 0 < n
                : op === "lte"
                  ? 0 <= n
                  : op === "gt"
                    ? 0 > n
                    : 0 >= n;
    return zero ? [missingKeys, ...numeric] : numeric;
}
/** A list's missing-value check or `length` comparison, answered by its size index. */
function sizeLookup(indexes: readonly StoredIndex[], filter: Filter): Plan | undefined {
    const sizeIndex = (field: Field) => indexes.find((i) => i.size && sameField(i.field, field));
    const counted = lengthComparison(filter);
    if (counted) {
        const index = sizeIndex(counted.field);
        const ranges = index && sizeRanges(counted.op, counted.bound);
        return index && ranges ? { kind: "lookup", index: index.name, ranges } : undefined;
    }
    const comparison = indexedComparison(filter);
    if (!comparison || comparison.value != null || (comparison.op !== "eq" && comparison.op !== "ne"))
        return undefined;
    const index = sizeIndex(comparison.field);
    if (!index) return undefined;
    const key = scalarKey(comparison.value);
    return {
        kind: "lookup",
        index: index.name,
        ranges:
            comparison.op === "eq"
                ? [{ lower: key, upper: key }]
                : [
                      { upper: key, upperOpen: true },
                      { lower: key, lowerOpen: true },
                  ],
    };
}
/** Combine same-index conjunctive bounds before scanning an ordered page. */
export function orderedRange(plan: Plan | undefined, index: string): Range | undefined {
    if (plan?.kind === "lookup")
        return plan.index === index && plan.ranges.length === 1 ? plan.ranges[0] : undefined;
    if (plan?.kind !== "and") return undefined;
    let result: Range | undefined;
    for (const child of plan.children) {
        const range = orderedRange(child, index);
        if (!range) continue;
        result ??= {};
        const lower =
            result.lower === undefined || (range.lower !== undefined && range.lower > result.lower)
                ? range
                : result;
        const upper =
            result.upper === undefined || (range.upper !== undefined && range.upper < result.upper)
                ? range
                : result;
        result = {
            lower: lower.lower,
            lowerOpen: lower.lowerOpen || (range.lower === result.lower && !!range.lowerOpen),
            upper: upper.upper,
            upperOpen: upper.upperOpen || (range.upper === result.upper && !!range.upperOpen),
        };
    }
    return result;
}
export const emptyRange = (range: Range): boolean =>
    range.lower !== undefined &&
    range.upper !== undefined &&
    (range.lower > range.upper || (range.lower === range.upper && (!!range.lowerOpen || !!range.upperOpen)));

export function executePlan(
    raw: DriverTransaction,
    table: string,
    plan: Plan
): Effect.Effect<Set<string>, OntologyStorageError> {
    const iterate = Effect.fnUntraced(function* (
        current: Plan,
        visit: (key: string) => void
    ): Effect.fn.Return<void, OntologyStorageError> {
        if (current.kind === "none") return;
        if (current.kind === "lookup") {
            // Independent IN ranges need no serial round trip per value. Each
            // range still advances its own bounded cursor; result ordering is
            // applied after hydration, never inferred from candidate arrival.
            yield* Effect.forEach(
                current.ranges,
                Effect.fnUntraced(function* (range) {
                    let after: Range["after"];
                    while (true) {
                        const entries = yield* raw.entries(table, current.index, {
                            ...range,
                            after,
                            limit: INDEX_BATCH_SIZE,
                        });
                        for (const entry of entries) visit(entry.key);
                        if (entries.length < INDEX_BATCH_SIZE) break;
                        const last = entries.at(-1)!;
                        after = { value: last.value, key: last.key };
                    }
                }),
                { concurrency: INDEX_BATCH_SIZE, discard: true }
            );
        } else if (current.kind === "or") {
            for (const child of current.children) yield* iterate(child, visit);
        } else {
            for (const key of yield* execute(current)) visit(key);
        }
    });
    const execute = Effect.fnUntraced(function* (
        current: Plan
    ): Effect.fn.Return<Set<string>, OntologyStorageError> {
        if (current.kind !== "and") {
            const keys = new Set<string>();
            yield* iterate(current, (key) => {
                keys.add(key);
            });
            return keys;
        }
        const estimated: { plan: Plan; count: number }[] = [];
        for (const child of current.children) {
            const count = yield* estimatePlan(raw, table, child);
            if (count === 0) return new Set<string>();
            estimated.push({ plan: child, count });
        }
        estimated.sort((a, b) => a.count - b.count);
        const first = estimated.shift();
        if (!first) return new Set<string>();
        let keys = yield* execute(first.plan);
        for (const child of estimated) {
            // Hydrating a tiny candidate set and evaluating the residual costs less
            // than reading a broad secondary index. Candidate supersets are safe.
            if (keys.size <= INDEX_BATCH_SIZE) break;
            const intersection = new Set<string>();
            yield* iterate(child.plan, (key) => {
                if (keys.has(key)) intersection.add(key);
            });
            keys = intersection;
        }
        return keys;
    });
    return execute(plan);
}

export const estimatePlan = Effect.fnUntraced(function* (
    raw: DriverTransaction,
    table: string,
    current: Plan
): Effect.fn.Return<number, OntologyStorageError> {
    if (current.kind === "none") return 0;
    if (current.kind === "lookup") {
        let total = 0;
        for (const range of current.ranges) total += yield* raw.countEntries(table, current.index, range);
        return total;
    }
    let total = current.kind === "and" ? Infinity : 0;
    for (const child of current.children) {
        const count = yield* estimatePlan(raw, table, child);
        total = current.kind === "and" ? Math.min(total, count) : total + count;
        if (current.kind === "and" && total === 0) break;
    }
    return total;
});
