import { isField } from "@party-stack/ontology-storage/tables";
import { convertLikeFilter } from "./convertLoadSubsetOptions.js";
import type { SearchJsonQueryV2 } from "@osdk/foundry.ontologies";
import type { SourceQueryPlan } from "@party-stack/ontology-backend";
import type { Predicate, Scalar } from "@party-stack/ontology-storage";

const scalar = (value: Scalar): unknown =>
    value instanceof Date
        ? value.toISOString()
        : typeof value === "object" && value !== null && "toString" in value
          ? value.toString()
          : value;

/** Conservative candidate filtering shared by HTTP reads and WebSocket watches.
 * Unsupported terms broaden membership, including unverified negation semantics.
 * Sort/limit/cursors stay local so watches include future window entrants.
 */
function translate(
    predicate: Predicate,
    recurse: (predicate: Predicate) => SearchJsonQueryV2 | undefined = translate
): SearchJsonQueryV2 | undefined {
    if (predicate.op === "and" || predicate.op === "or") {
        const children = predicate.predicates.map((child) => recurse(child));
        if (predicate.op === "or" && children.some((child) => !child)) return;
        const supported = children.filter((child): child is SearchJsonQueryV2 => child !== undefined);
        if (!supported.length) return;
        return { type: predicate.op, value: supported };
    }
    if (predicate.op === "not" || predicate.op === "ne") return;
    if (predicate.op === "like" || predicate.op === "ilike") {
        if (
            !isField(predicate.left) ||
            predicate.left.path.length !== 1 ||
            typeof predicate.right !== "string"
        )
            return;
        // Portable LIKE follows TanStack's literal-backslash semantics. Foundry
        // may overfetch; exact storage evaluation still precedes pagination.
        return convertLikeFilter([...predicate.left.path], predicate.right, true).query;
    }
    if (predicate.op === "contains") {
        if (
            predicate.left.path.length !== 1 ||
            isField(predicate.right) ||
            predicate.right == null ||
            typeof predicate.right === "bigint"
        )
            return;
        return { type: "contains", field: predicate.left.path[0]!, value: scalar(predicate.right) };
    }
    let left = predicate.left;
    if (predicate.op === "in") {
        if (
            !isField(left) ||
            left.path.length !== 1 ||
            predicate.values.some((value) => value == null || typeof value === "bigint")
        )
            return;
        return { type: "in", field: left.path[0]!, value: predicate.values.map(scalar) };
    }
    let right = predicate.right;
    let operation = predicate.op;
    if (isField(right) && !isField(left)) {
        [left, right] = [right, left];
        operation = { eq: "eq", gt: "lt", gte: "lte", lt: "gt", lte: "gte" }[operation] as typeof operation;
    }
    if (
        !isField(left) ||
        isField(right) ||
        left.path.length !== 1 ||
        right == null ||
        typeof right === "bigint"
    )
        return;
    const query: SearchJsonQueryV2 = { type: operation, field: left.path[0]!, value: scalar(right) };
    // Storage has an explicit ordering for missing/nullish values; provider range
    // filters need not share it. Including nulls preserves a candidate superset.
    return operation === "eq"
        ? query
        : { type: "or", value: [query, { type: "isNull", field: left.path[0]!, value: true }] };
}

export const subsetFilter = (predicate: Predicate | undefined): SearchJsonQueryV2 | undefined =>
    predicate ? translate(predicate) : undefined;

/** Report effective placement, including supported OR branches that could not safely be sent. */
export function analyzeSubsetFilter(predicate: Predicate | undefined) {
    const translated = new Map<Predicate, SearchJsonQueryV2 | undefined>();
    const visit = (predicate: Predicate): SearchJsonQueryV2 | undefined => {
        const query = translate(predicate, visit);
        translated.set(predicate, query);
        return query;
    };
    const query = predicate ? visit(predicate) : undefined;
    const predicates: SourceQueryPlan["predicates"][number][] = [];
    const report = (predicate: Predicate, path: readonly number[], allowed: boolean): void => {
        const sent = allowed && translated.get(predicate) !== undefined;
        if (predicate.op === "and" || predicate.op === "or") {
            predicate.predicates.forEach((child, index) => report(child, [...path, index], sent));
        } else if (predicate.op === "not") {
            report(predicate.predicate, [...path, 0], false);
        } else {
            predicates.push({
                path,
                execution: !sent
                    ? "adapter"
                    : ["like", "ilike", "gt", "gte", "lt", "lte"].includes(predicate.op)
                      ? "candidate"
                      : "source",
            });
        }
    };
    if (predicate) report(predicate, [], true);
    return { query, predicates };
}
