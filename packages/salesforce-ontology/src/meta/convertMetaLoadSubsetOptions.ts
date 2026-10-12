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
