import { fieldValues, filterOperand } from "@party-stack/ontology-storage/tables";
import type { Filter, Query } from "@party-stack/ontology-storage";

export type MetaNameQuery =
    | { type: "getBatch"; names: string[] }
    | {
          type: "search";
          field: "name" | "displayName";
          pattern: string;
          caseInsensitive: boolean;
      }
    | { type: "list" };

export function matchesMetaNameQuery(
    query: MetaNameQuery,
    value: {
        name: string;
        displayName: string;
    }
): boolean {
    if (query.type !== "search") return true;
    const escaped = query.pattern.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
    const expression = escaped.replaceAll("%", ".*").replaceAll("_", ".");
    return new RegExp(`^${expression}$`, query.caseInsensitive ? "i" : undefined).test(value[query.field]);
}

/** Native storage query candidate selection; the caller rechecks the entire predicate. */
export function convertStorageMetaNameQuery(query?: Query): MetaNameQuery {
    const visit = (predicate?: Filter): MetaNameQuery => {
        if (!predicate) return { type: "list" };
        const names = fieldValues(predicate, ["name"]);
        if (names?.every((value) => typeof value === "string"))
            return { type: "getBatch", names: [...names] as string[] };
        if (predicate.kind === "like" || predicate.kind === "ilike") {
            const left = filterOperand(predicate.value.left);
            const right = filterOperand(predicate.value.right);
            if (
                left?.kind === "field" &&
                left.field.path.join(".") === "name" &&
                right?.kind === "literal" &&
                typeof right.value === "string"
            )
                return {
                    type: "search",
                    field: "name",
                    pattern: right.value,
                    caseInsensitive: predicate.kind === "ilike",
                };
        }
        if (predicate.kind === "and")
            return (
                predicate.value.expressions.map(visit).find((child) => child.type === "getBatch") ?? {
                    type: "list",
                }
            );
        if (predicate.kind === "or") {
            const children = predicate.value.expressions.map(visit);
            if (children.every((child) => child.type === "getBatch"))
                return { type: "getBatch", names: [...new Set(children.flatMap((child) => child.names))] };
        }
        return { type: "list" };
    };
    return visit(query?.where);
}
