import { FieldPath, LoadSubsetOptions, parseWhereExpression } from "@tanstack/db";

export type ActionTypeRidQuery =
    | { type: "byRid"; rids: string[] }
    | { type: "search" };

/**
 * Detects exact ActionType.id RID lookups so they can be resolved via
 * `ActionTypesV2.getByRid` instead of the search endpoint (which cannot filter by RID).
 *
 * Only pure `eq` / `inArray` trees over `id` are pushed down. Mixed predicates fall back to search.
 */
export function convertActionTypeRidQuery(options?: LoadSubsetOptions): ActionTypeRidQuery {
    if (!options?.where) {
        return { type: "search" };
    }

    const ridQuery =
        parseWhereExpression<ActionTypeRidQuery | undefined>(options.where, {
            handlers: {
                and: (...queries: Array<ActionTypeRidQuery | undefined>) => {
                    const ridQueries = queries.filter(
                        (query): query is Extract<ActionTypeRidQuery, { type: "byRid" }> =>
                            query?.type === "byRid"
                    );
                    if (ridQueries.length === 0 || ridQueries.length !== queries.length) {
                        return undefined;
                    }
                    return {
                        type: "byRid",
                        rids: Array.from(new Set(ridQueries.flatMap((query) => query.rids))),
                    };
                },
                or: (...queries: Array<ActionTypeRidQuery | undefined>) => {
                    const ridQueries = queries.filter(
                        (query): query is Extract<ActionTypeRidQuery, { type: "byRid" }> =>
                            query?.type === "byRid"
                    );
                    if (ridQueries.length === 0 || ridQueries.length !== queries.length) {
                        return undefined;
                    }
                    return {
                        type: "byRid",
                        rids: Array.from(new Set(ridQueries.flatMap((query) => query.rids))),
                    };
                },
                eq: (field: FieldPath, value: unknown) => {
                    if (field.join(".") === "id" && typeof value === "string") {
                        return { type: "byRid", rids: [value] };
                    }
                },
                in: (field: FieldPath, values: unknown[]) => {
                    if (field.join(".") === "id") {
                        return {
                            type: "byRid",
                            rids: values
                                .filter((candidate): candidate is string => typeof candidate === "string")
                                .filter(Boolean),
                        };
                    }
                },
            },
            onUnknownOperator: () => undefined,
        }) ?? undefined;

    return ridQuery?.type === "byRid" ? ridQuery : { type: "search" };
}
