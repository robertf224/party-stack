import { isField } from "@party-stack/ontology-storage/tables";
import type { Key, Query } from "@party-stack/ontology-storage";

/** Ordering alone does not restrict which rows a complete snapshot contains. */
export function isWholeCollection(query: Query | undefined): boolean {
    return !query?.where && query?.limit === undefined && !query?.offset && !query?.after;
}

/** The initial overlap optimization deliberately recognizes only an exact primary-key lookup. */
export function primaryKeyLookup(query: Query | undefined, primaryKey: string): Key | undefined {
    if (!query?.where || query.where.op !== "eq" || query.after || query.offset || query.limit === 0)
        return undefined;
    const { left, right } = query.where;
    const key =
        isField(left) && left.path.length === 1 && left.path[0] === primaryKey
            ? right
            : isField(right) && right.path.length === 1 && right.path[0] === primaryKey
              ? left
              : undefined;
    return typeof key === "string" || (typeof key === "number" && Number.isFinite(key)) ? key : undefined;
}

export function hasWindow(query: Query | undefined): boolean {
    return query?.limit !== undefined || Boolean(query?.offset) || query?.after !== undefined;
}
