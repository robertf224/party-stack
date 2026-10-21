import { FieldPath, LoadSubsetOptions, parseOrderByExpression, parseWhereExpression } from "@tanstack/db";
import { quoteSoqlIdentifier, serializeSoqlLiteral, type CompiledSoqlFilter } from "./soql.js";
export { buildSoqlQuery, serializeSoqlLiteral } from "./soql.js";
export type { CompiledSoqlFilter } from "./soql.js";

const ALWAYS_FALSE = "__ALWAYS_FALSE__";

function fieldPathToSoql(fieldPath: FieldPath): string {
    if (fieldPath.length === 0) {
        throw new Error("Empty field path.");
    }
    return fieldPath.map((segment) => quoteSoqlIdentifier(String(segment))).join(".");
}

export function isAlwaysFalseFilter(filter: CompiledSoqlFilter | undefined): boolean {
    return Boolean(filter?.alwaysFalse);
}

function convertInFilter(fieldOrValue: unknown, valuesOrField: unknown): string {
    if (!Array.isArray(valuesOrField)) {
        throw new Error("Expected the second inArray argument to be an array or field path");
    }

    if (!Array.isArray(fieldOrValue)) {
        return fieldOrValue == null
            ? ALWAYS_FALSE
            : `${fieldPathToSoql(valuesOrField as FieldPath)} INCLUDES (${serializeSoqlLiteral(fieldOrValue)})`;
    }

    const literals = (valuesOrField as unknown[])
        .filter((entry) => entry !== null && entry !== undefined)
        .map(serializeSoqlLiteral);
    if (literals.length === 0) return ALWAYS_FALSE;
    return `${fieldPathToSoql(fieldOrValue as FieldPath)} IN (${literals.join(", ")})`;
}

export function convertLoadSubsetFilter(filter: LoadSubsetOptions["where"]): CompiledSoqlFilter | undefined {
    if (!filter) return undefined;

    const compiled =
        parseWhereExpression<string>(filter, {
            handlers: {
                and: (...filters: string[]) => {
                    if (filters.includes(ALWAYS_FALSE)) return ALWAYS_FALSE;
                    const clauses = filters.filter((clause) => clause.length > 0);
                    if (clauses.length === 0) return "";
                    if (clauses.length === 1) return clauses[0]!;
                    return `(${clauses.join(" AND ")})`;
                },
                or: (...filters: string[]) => {
                    if (filters.every((clause) => clause === ALWAYS_FALSE)) return ALWAYS_FALSE;
                    const clauses = filters.filter((clause) => clause !== ALWAYS_FALSE && clause.length > 0);
                    if (clauses.length === 0) return "";
                    if (clauses.length === 1) return clauses[0]!;
                    return `(${clauses.join(" OR ")})`;
                },
                not: (inner: string) => {
                    if (inner === ALWAYS_FALSE) return "";
                    if (!inner) return ALWAYS_FALSE;
                    return `(NOT ${inner})`;
                },
                eq: (field: FieldPath, value) =>
                    value == null
                        ? `${fieldPathToSoql(field)} = null`
                        : `${fieldPathToSoql(field)} = ${serializeSoqlLiteral(value)}`,
                gt: (field: FieldPath, value) =>
                    value == null
                        ? ALWAYS_FALSE
                        : `${fieldPathToSoql(field)} > ${serializeSoqlLiteral(value)}`,
                gte: (field: FieldPath, value) =>
                    value == null
                        ? ALWAYS_FALSE
                        : `${fieldPathToSoql(field)} >= ${serializeSoqlLiteral(value)}`,
                lt: (field: FieldPath, value) =>
                    value == null
                        ? ALWAYS_FALSE
                        : `${fieldPathToSoql(field)} < ${serializeSoqlLiteral(value)}`,
                lte: (field: FieldPath, value) =>
                    value == null
                        ? ALWAYS_FALSE
                        : `${fieldPathToSoql(field)} <= ${serializeSoqlLiteral(value)}`,
                isUndefined: (field: FieldPath) => `${fieldPathToSoql(field)} = null`,
                in: convertInFilter,
                like: (field: FieldPath, value: string) =>
                    value === "%" ? "" : `${fieldPathToSoql(field)} LIKE ${serializeSoqlLiteral(value)}`,
                ilike: (field: FieldPath, value: string) =>
                    // Salesforce LIKE is case-insensitive for most text fields.
                    value === "%" ? "" : `${fieldPathToSoql(field)} LIKE ${serializeSoqlLiteral(value)}`,
            },
        }) ?? undefined;

    if (compiled === undefined) return undefined;
    if (compiled === ALWAYS_FALSE) {
        return { alwaysFalse: true };
    }
    return { clause: compiled || undefined, alwaysFalse: false };
}

export function convertLoadSubsetOrderBy(orderBy: LoadSubsetOptions["orderBy"]): string | undefined {
    if (!orderBy) return undefined;
    const fields = parseOrderByExpression(orderBy).map((ordering) => {
        const field = fieldPathToSoql(ordering.field);
        return `${field} ${ordering.direction.toUpperCase()}`;
    });
    return fields.length > 0 ? fields.join(", ") : undefined;
}
