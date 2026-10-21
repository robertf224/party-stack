import { isField } from "@party-stack/ontology-storage/tables";
import { FieldPath, type LoadSubsetOptions, parseWhereExpression } from "@tanstack/db";

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

export function convertMetaNameQuery(options?: LoadSubsetOptions): MetaNameQuery {
    if (!options?.where) return { type: "list" };
    const batch =
        parseWhereExpression<MetaNameQuery | undefined>(options.where, {
            handlers: {
                eq: (field: FieldPath, value: unknown) =>
                    field.join(".") === "name"
                        ? {
                              type: "getBatch",
                              names: [String(value)],
                          }
                        : undefined,
                in: (field: FieldPath, values: unknown[]) =>
                    field.join(".") === "name"
                        ? {
                              type: "getBatch",
                              names: values
                                  .filter((value) => value !== null && value !== undefined)
                                  .map(String),
                          }
                        : undefined,
                like: (field: FieldPath, pattern: string) => {
                    const name = field.join(".");
                    return name === "name" || name === "displayName"
                        ? {
                              type: "search",
                              field: name,
                              pattern,
                              caseInsensitive: false,
                          }
                        : undefined;
                },
                ilike: (field: FieldPath, pattern: string) => {
                    const name = field.join(".");
                    return name === "name" || name === "displayName"
                        ? {
                              type: "search",
                              field: name,
                              pattern,
                              caseInsensitive: true,
                          }
                        : undefined;
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;
    return batch ?? { type: "list" };
}

/** Native storage query candidate selection; the caller rechecks the entire predicate. */
export function convertStorageMetaNameQuery(
    query?: import("@party-stack/ontology-storage").Query
): MetaNameQuery {
    const visit = (predicate?: import("@party-stack/ontology-storage").Predicate): MetaNameQuery => {
        if (!predicate) return { type: "list" };
        if (predicate.op === "eq") {
            const field = isField(predicate.left) ? predicate.left : predicate.right;
            const value = field === predicate.left ? predicate.right : predicate.left;
            if (isField(field) && field.path.join(".") === "name" && typeof value === "string")
                return { type: "getBatch", names: [value] };
        }
        if (
            predicate.op === "in" &&
            isField(predicate.left) &&
            predicate.left.path.join(".") === "name" &&
            predicate.values.every((value) => typeof value === "string")
        )
            return { type: "getBatch", names: [...predicate.values] as string[] };
        if (
            (predicate.op === "like" || predicate.op === "ilike") &&
            isField(predicate.left) &&
            predicate.left.path.join(".") === "name" &&
            typeof predicate.right === "string"
        )
            return {
                type: "search",
                field: "name",
                pattern: predicate.right,
                caseInsensitive: predicate.op === "ilike",
            };
        if (predicate.op === "and")
            return (
                predicate.predicates.map(visit).find((child) => child.type === "getBatch") ?? { type: "list" }
            );
        if (predicate.op === "or") {
            const children = predicate.predicates.map(visit);
            if (children.every((child) => child.type === "getBatch"))
                return { type: "getBatch", names: [...new Set(children.flatMap((child) => child.names))] };
        }
        return { type: "list" };
    };
    return visit(query?.where);
}
