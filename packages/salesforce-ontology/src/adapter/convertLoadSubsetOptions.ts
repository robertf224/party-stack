import {
    FieldPath,
    LoadSubsetOptions,
    parseOrderByExpression,
    parseWhereExpression,
} from "@tanstack/db";
import { Temporal } from "temporal-polyfill";

const ALWAYS_FALSE = "__ALWAYS_FALSE__";

export type CompiledSoqlFilter = {
    clause?: string;
    alwaysFalse: boolean;
};

function quoteIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Invalid Salesforce identifier "${identifier}".`);
    }
    return identifier;
}

function fieldPathToSoql(fieldPath: FieldPath): string {
    if (fieldPath.length === 0) {
        throw new Error("Empty field path.");
    }
    return fieldPath.map((segment) => quoteIdentifier(String(segment))).join(".");
}

function escapeSoqlString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function serializeSoqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return "null";
    }
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`Cannot serialize non-finite number ${value} to SOQL.`);
        }
        return String(value);
    }
    if (typeof value === "bigint") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Temporal.Instant) {
        return value.toString();
    }
    if (value instanceof Temporal.PlainDate || value instanceof Temporal.PlainDateTime) {
        return value.toString();
    }
    if (typeof value === "string") {
        return `'${escapeSoqlString(value)}'`;
    }
    throw new Error(`Unsupported SOQL literal type: ${typeof value}`);
}

export function isAlwaysFalseFilter(filter: CompiledSoqlFilter | undefined): boolean {
    return Boolean(filter?.alwaysFalse);
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
                    value == null ? ALWAYS_FALSE : `${fieldPathToSoql(field)} > ${serializeSoqlLiteral(value)}`,
                gte: (field: FieldPath, value) =>
                    value == null ? ALWAYS_FALSE : `${fieldPathToSoql(field)} >= ${serializeSoqlLiteral(value)}`,
                lt: (field: FieldPath, value) =>
                    value == null ? ALWAYS_FALSE : `${fieldPathToSoql(field)} < ${serializeSoqlLiteral(value)}`,
                lte: (field: FieldPath, value) =>
                    value == null ? ALWAYS_FALSE : `${fieldPathToSoql(field)} <= ${serializeSoqlLiteral(value)}`,
                isNull: (field: FieldPath) => `${fieldPathToSoql(field)} = null`,
                in: (field: FieldPath, values: unknown[]) => {
                    const literals = values
                        .filter((entry) => entry !== null && entry !== undefined)
                        .map(serializeSoqlLiteral);
                    if (literals.length === 0) return ALWAYS_FALSE;
                    return `${fieldPathToSoql(field)} IN (${literals.join(", ")})`;
                },
                like: (field: FieldPath, value: string) =>
                    value === "%"
                        ? ""
                        : `${fieldPathToSoql(field)} LIKE ${serializeSoqlLiteral(value)}`,
                ilike: (field: FieldPath, value: string) =>
                    // Salesforce LIKE is case-insensitive for most text fields.
                    value === "%"
                        ? ""
                        : `${fieldPathToSoql(field)} LIKE ${serializeSoqlLiteral(value)}`,
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

export function buildSoqlQuery(opts: {
    objectType: string;
    selectedProperties: string[];
    where?: CompiledSoqlFilter;
    orderBy?: string;
    limit?: number;
    offset?: number;
}): string {
    const objectType = quoteIdentifier(opts.objectType);
    const select = opts.selectedProperties.map(quoteIdentifier).join(", ");
    const clauses = [`SELECT ${select} FROM ${objectType}`];

    if (opts.where?.clause) {
        clauses.push(`WHERE ${opts.where.clause}`);
    }
    if (opts.orderBy) {
        clauses.push(`ORDER BY ${opts.orderBy}`);
    }
    if (opts.limit !== undefined) {
        clauses.push(`LIMIT ${Math.max(0, Math.trunc(opts.limit))}`);
    }
    if (opts.offset !== undefined && opts.offset > 0) {
        clauses.push(`OFFSET ${Math.max(0, Math.trunc(opts.offset))}`);
    }
    return clauses.join(" ");
}
