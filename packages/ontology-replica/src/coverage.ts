import { filterOperand } from "@party-stack/ontology-storage/tables";
import type { Key, Query } from "@party-stack/ontology-storage";

/** Ordering alone does not restrict which rows a complete snapshot contains. */
export function isWholeCollection(query: Query | undefined): boolean {
    return !query?.where && query?.limit === undefined && !query?.offset && !query?.after;
}

/** The initial overlap optimization deliberately recognizes only an exact primary-key lookup. */
export function primaryKeyLookup(query: Query | undefined, primaryKey: string): Key | undefined {
    if (!query?.where || query.where.kind !== "eq" || query.after || query.offset || query.limit === 0)
        return undefined;
    const left = filterOperand(query.where.value.left);
    const right = filterOperand(query.where.value.right);
    const isKey = (operand: typeof left) =>
        operand?.kind === "field" && operand.field.path.length === 1 && operand.field.path[0] === primaryKey;
    const other = isKey(left) ? right : isKey(right) ? left : undefined;
    const key = other?.kind === "literal" ? other.value : undefined;
    return typeof key === "string" || (typeof key === "number" && Number.isFinite(key)) ? key : undefined;
}

/** A complete leading window that returned fewer rows than its limit holds every row its
 * filter matches, so it also proves the unwindowed filter. Ordered and limited live queries
 * rely on this to answer their follow-up reads (ties at the boundary, the rows after it)
 * locally. A cursor or offset window proves only its own range. */
export function shortWindowFilter(
    query: Query | undefined,
    complete: boolean,
    rows: number
): Query | undefined | false {
    if (!complete || query?.limit === undefined || query.offset || query.after !== undefined) return false;
    if (rows >= query.limit) return false;
    return query.where ? { where: query.where } : undefined;
}

export function hasWindow(query: Query | undefined): boolean {
    return query?.limit !== undefined || Boolean(query?.offset) || query?.after !== undefined;
}
