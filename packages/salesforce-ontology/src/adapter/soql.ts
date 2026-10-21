import { Temporal } from "temporal-polyfill";

export type CompiledSoqlFilter = {
    clause?: string;
    alwaysFalse: boolean;
};

export function quoteSoqlIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Invalid Salesforce identifier "${identifier}".`);
    }
    return identifier;
}

function escapeSoqlString(value: string): string {
    let escaped = "";
    for (const character of value) {
        switch (character) {
            case "\\":
                escaped += "\\\\";
                break;
            case "'":
                escaped += "\\'";
                break;
            case "\b":
                escaped += "\\b";
                break;
            case "\f":
                escaped += "\\f";
                break;
            case "\n":
                escaped += "\\n";
                break;
            case "\r":
                escaped += "\\r";
                break;
            case "\t":
                escaped += "\\t";
                break;
            default: {
                const codePoint = character.codePointAt(0)!;
                if (codePoint < 0x20 || codePoint === 0x7f) {
                    throw new Error(
                        `Cannot serialize control character U+${codePoint.toString(16).padStart(4, "0")} to SOQL.`
                    );
                }
                escaped += character;
            }
        }
    }
    return escaped;
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

export function buildSoqlQuery(opts: {
    objectType: string;
    selectedProperties: string[];
    where?: CompiledSoqlFilter;
    orderBy?: string;
    limit?: number;
    offset?: number;
}): string {
    const objectType = quoteSoqlIdentifier(opts.objectType);
    const select = opts.selectedProperties.map(quoteSoqlIdentifier).join(", ");
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
