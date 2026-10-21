import { Effect } from "effect";
import { sameField, scalarKey, caseInsensitiveIndex, indexedComparison } from "../query/evaluate.js";
import { isField } from "../query/schema.js";
import type { DriverTransaction, Range, StoredIndex } from "../driver/index.js";
import type { Predicate, OntologyStorageError } from "../model.js";

/** Candidate plans are supersets; the complete predicate is always evaluated on hydrated rows. */
export type Plan =
    | { readonly kind: "none" }
    | { readonly kind: "lookup"; readonly index: string; readonly ranges: readonly Range[] }
    | { readonly kind: "and" | "or"; readonly children: readonly Plan[] };
export const INDEX_BATCH_SIZE = 128;
export function selectPlan(indexes: readonly StoredIndex[], predicate?: Predicate): Plan | undefined {
    if (!predicate || predicate.op === "not") return undefined;
    if (predicate.op === "and" || predicate.op === "or") {
        const children = predicate.predicates.map((p) => selectPlan(indexes, p));
        if (predicate.op === "or" && children.some((p) => p === undefined)) return undefined;
        if (predicate.op === "and" && children.some((p) => p?.kind === "none")) return { kind: "none" };
        const available = children.filter((p): p is Plan => p !== undefined && p.kind !== "none");
        if (!available.length) return predicate.op === "or" ? { kind: "none" } : undefined;
        if (available.length === 1) return available[0];
        return { kind: predicate.op, children: available };
    }
    const comparison = indexedComparison(predicate);
    const reference =
        comparison?.field ??
        ((predicate.op === "contains" ||
            predicate.op === "in" ||
            predicate.op === "like" ||
            predicate.op === "ilike") &&
        isField(predicate.left)
            ? predicate.left
            : undefined);
    if (!reference || comparison?.op === "ne") return undefined;
    const index = indexes.find(
        (i) => sameField(i.field, reference) && !!i.multiEntry === (predicate.op === "contains")
    );
    if (!index) return undefined;
    let ranges: Range[];
    if (predicate.op === "contains") {
        if (isField(predicate.right)) return undefined;
        const value = scalarKey(predicate.right);
        ranges = [{ lower: value, upper: value }];
    } else if (predicate.op === "in") {
        ranges = [...new Set(predicate.values.map(scalarKey))].map((value) => ({
            lower: value,
            upper: value,
        }));
    } else if (predicate.op === "like" || predicate.op === "ilike") {
        if (typeof predicate.right !== "string") return undefined;
        const pattern = predicate.op === "ilike" ? predicate.right.toLowerCase() : predicate.right;
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
              index: predicate.op === "ilike" ? caseInsensitiveIndex(index.name) : index.name,
              ranges,
          }
        : { kind: "none" };
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
            for (const range of current.ranges) {
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
            }
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
