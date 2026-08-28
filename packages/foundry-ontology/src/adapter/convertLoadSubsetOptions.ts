import {
    PropertyApiName,
    PropertyIdentifier,
    SearchJsonQueryV2,
    SearchOrderByV2,
    StructFieldApiName,
} from "@osdk/foundry.ontologies";
import { FieldPath, LoadSubsetOptions, parseOrderByExpression, parseWhereExpression } from "@tanstack/db";
import { Temporal } from "temporal-polyfill";

const ALWAYS_FALSE_FILTER: SearchJsonQueryV2 = { type: "or", value: [] };
const ALWAYS_TRUE_FILTER: SearchJsonQueryV2 = { type: "and", value: [] };

type LikePatternPart =
    | { type: "literal"; value: string }
    | { type: "many" }
    | { type: "single" };

interface PushdownFilter {
    query: SearchJsonQueryV2;
    safeToNegate: boolean;
}

function pushdown(query: SearchJsonQueryV2, safeToNegate = true): PushdownFilter {
    return { query, safeToNegate };
}

function parseLikePattern(pattern: string): LikePatternPart[] {
    const parts: LikePatternPart[] = [];
    let literal = "";

    const flushLiteral = () => {
        if (literal) {
            parts.push({ type: "literal", value: literal });
            literal = "";
        }
    };

    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index]!;
        if (character === "\\") {
            const escaped = pattern[index + 1];
            if (escaped === "%" || escaped === "_" || escaped === "\\") {
                literal += escaped;
                index++;
            } else {
                literal += character;
            }
        } else if (character === "%") {
            flushLiteral();
            parts.push({ type: "many" });
        } else if (character === "_") {
            flushLiteral();
            parts.push({ type: "single" });
        } else {
            literal += character;
        }
    }
    flushLiteral();

    return parts;
}

function escapeFoundryWildcardLiteral(value: string): string {
    return value.replace(/[\\*?]/g, "\\$&");
}

function convertLikeFilter(field: FieldPath, value: string): PushdownFilter {
    const parts = parseLikePattern(value.toLowerCase());
    const hasLeadingWildcard = parts[0]?.type === "many";
    const hasTrailingWildcard = parts.at(-1)?.type === "many";
    const propertyIdentifier = fieldPathToPropertyIdentifier(field);

    if (hasLeadingWildcard && hasTrailingWildcard) {
        const terms = parts.flatMap((part) => (part.type === "literal" && part.value ? [part.value] : []));
        const queries = terms.map<SearchJsonQueryV2>((term) => ({
            // This is Foundry's substring/phrase query. It can over-fetch because
            // wildcard-delimited terms are not required to be adjacent or ordered.
            type: "containsAllTermsInOrder",
            propertyIdentifier,
            value: term,
        }));
        const query: SearchJsonQueryV2 =
            queries.length === 0
                ? ALWAYS_TRUE_FILTER
                : queries.length === 1
                  ? queries[0]!
                  : { type: "and", value: queries };

        // Contains is an approximation of SQL LIKE. Negating this superset
        // would produce a subset and could hide exact matches.
        return pushdown(query, false);
    }

    const wildcard = parts
        .map((part) => {
            if (part.type === "many") return "*";
            if (part.type === "single") return "?";
            return escapeFoundryWildcardLiteral(part.value);
        })
        .join("");

    return pushdown({
        type: "wildcard",
        propertyIdentifier,
        value: wildcard,
    });
}

function convertQueryValue(
    value: unknown
): unknown {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (
        value instanceof Temporal.Instant ||
        value instanceof Temporal.PlainDate ||
        value instanceof Temporal.PlainDateTime
    ) {
        return value.toString();
    }
    return value;
}

function fieldPathToPropertyIdentifier(fieldPath: FieldPath): PropertyIdentifier {
    if (fieldPath.length === 1) {
        return {
            type: "property",
            apiName: fieldPath[0]! as PropertyApiName,
        };
    } else if (fieldPath.length === 2) {
        return {
            type: "structField",
            propertyApiName: fieldPath[0]! as PropertyApiName,
            structFieldApiName: fieldPath[1]! as StructFieldApiName,
        };
    }
    throw new Error(`Invalid field path: ${fieldPath.join(".")}`);
}

export function isAlwaysFalseFilter(filter: SearchJsonQueryV2 | undefined): boolean {
    return filter?.type === "or" && filter.value.length === 0;
}

export function convertLoadSubsetFilter(filter: LoadSubsetOptions["where"]): SearchJsonQueryV2 | undefined {
    return (
        parseWhereExpression<PushdownFilter>(filter, {
            handlers: {
                and: (...filters: PushdownFilter[]) =>
                    pushdown(
                        { type: "and", value: filters.map(({ query }) => query) },
                        filters.every(({ safeToNegate }) => safeToNegate)
                    ),
                or: (...filters: PushdownFilter[]) =>
                    pushdown(
                        { type: "or", value: filters.map(({ query }) => query) },
                        filters.every(({ safeToNegate }) => safeToNegate)
                    ),
                not: (filter: PushdownFilter) =>
                    filter.safeToNegate
                        ? pushdown({ type: "not", value: filter.query })
                        : pushdown(ALWAYS_TRUE_FILTER, false),
                eq: (field: FieldPath, value) =>
                    pushdown(
                        value == null
                            ? {
                                  type: "isNull",
                                  propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                  value: true,
                              }
                            : {
                                  type: "eq",
                                  propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                  value:
                                      convertQueryValue(value),
                              }
                    ),
                gt: (field: FieldPath, value) =>
                    pushdown(
                        value == null
                            ? ALWAYS_FALSE_FILTER
                            : {
                                  type: "gt",
                                  propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                  value:
                                      convertQueryValue(value),
                              }
                    ),
                gte: (field: FieldPath, value) =>
                    pushdown(
                        value == null
                            ? ALWAYS_FALSE_FILTER
                            : {
                                  type: "gte",
                                  propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                  value:
                                      convertQueryValue(value),
                              }
                    ),
                lt: (field: FieldPath, value) =>
                    pushdown(
                        value == null
                            ? ALWAYS_FALSE_FILTER
                            : {
                                  type: "lt",
                                  propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                  value:
                                      convertQueryValue(value),
                              }
                    ),
                lte: (field: FieldPath, value) =>
                    pushdown(
                        value == null
                            ? ALWAYS_FALSE_FILTER
                            : {
                                  type: "lte",
                                  propertyIdentifier: fieldPathToPropertyIdentifier(field),
                                  value:
                                      convertQueryValue(value),
                              }
                    ),
                isNull: (field: FieldPath) => ({
                    query: {
                        type: "isNull",
                        propertyIdentifier: fieldPathToPropertyIdentifier(field),
                        value: true,
                    },
                    safeToNegate: true,
                }),
                in: (field: FieldPath, value: unknown[]) =>
                    pushdown({
                        type: "in",
                        propertyIdentifier: fieldPathToPropertyIdentifier(field),
                        value: value
                            .filter(
                                (entry) =>
                                    entry !== null &&
                                    entry !== undefined
                            )
                            .map(convertQueryValue),
                    }),
                ilike: convertLikeFilter,
                // Foundry wildcard and contains searches are case-insensitive,
                // so LIKE can over-fetch while TanStack applies exact casing.
                like: convertLikeFilter,
            },
        })?.query ?? undefined
    );
}

export function convertLoadSubsetOrderBy(orderBy: LoadSubsetOptions["orderBy"]): SearchOrderByV2 | undefined {
    return orderBy
        ? {
              fields: parseOrderByExpression(orderBy).map((ordering) => ({
                  field: ordering.field[0]! as PropertyApiName,
                  direction: ordering.direction,
              })),
          }
        : undefined;
}
