import {
    and,
    contains,
    eq,
    evaluateQuery,
    field,
    gt,
    gte,
    ilike,
    inArray,
    like,
    lt,
    lte,
    not,
    or,
    type Predicate,
    type Scalar,
} from "@party-stack/ontology-storage";
import { encodeAuthValue, type AuthRow, type AuthSchema } from "./model.js";
import type { CustomAdapter } from "better-auth/adapters";

type Clause = Parameters<CustomAdapter["findOne"]>[0]["where"][number];
export interface AuthQuery {
    readonly where?: Predicate;
    readonly residual: boolean;
    readonly matches: (row: AuthRow) => boolean;
}

/** Better Auth's SQL adapters use (all AND clauses) AND (any OR clauses). */
export function authQuery(schema: AuthSchema, model: string, clauses: readonly Clause[] = []): AuthQuery {
    const table = schema[model];
    if (!table) throw new TypeError("Unknown authentication model.");
    const compiled = clauses.map((clause) => {
        const { field: name, operator, value, mode } = clause;
        if (name !== "id" && !Object.hasOwn(table.fields, name))
            throw new TypeError("Unknown authentication field.");
        const attribute = table.fields[name];
        const key = field(name);
        const scalar = (value: unknown) => encodeAuthValue(attribute, value) as Scalar;
        const insensitive = mode === "insensitive";
        const wildcard = (value: string) => value.includes("%") || value.includes("_");
        const textEquals = (value: string) => (insensitive ? ilike(key, value) : eq(key, value));
        const equal = (value: unknown): Predicate =>
            value === null
                ? eq(key, undefined)
                : typeof value === "string"
                  ? textEquals(value)
                  : eq(key, scalar(value));
        let predicate: Predicate | undefined;
        let residual = false;
        let matches: ((row: AuthRow) => boolean) | undefined;
        if (operator === "in" || operator === "not_in") {
            if (!Array.isArray(value)) throw new TypeError("Membership filters require a list.");
            residual = insensitive && value.some((entry) => typeof entry === "string" && wildcard(entry));
            predicate = residual
                ? undefined
                : insensitive
                  ? or(...value.map(equal))
                  : inArray(key, value.map(scalar));
            if (operator === "not_in" && predicate) predicate = not(predicate);
            const normalized = value.map((entry) =>
                insensitive && typeof entry === "string" ? entry.toLowerCase() : entry
            );
            matches = (row) => {
                const actual =
                    insensitive && typeof row[name] === "string" ? row[name].toLowerCase() : row[name];
                const included = normalized.includes(actual as never);
                return operator === "in" ? included : !included;
            };
        } else if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
            if (attribute?.type === "string[]" || attribute?.type === "number[]") {
                if (operator !== "contains" || insensitive) throw new TypeError("Unsupported array filter.");
                predicate = contains(key, scalar(value));
            } else {
                if (typeof value !== "string") throw new TypeError("String filters require text.");
                const pattern = `${operator !== "starts_with" ? "%" : ""}${value}${operator !== "ends_with" ? "%" : ""}`;
                predicate = insensitive ? ilike(key, pattern) : like(key, pattern);
                residual = wildcard(value);
                matches = (row) => {
                    const actual = row[name];
                    if (typeof actual !== "string") return false;
                    const text = insensitive ? actual.toLowerCase() : actual;
                    const search = insensitive ? value.toLowerCase() : value;
                    return operator === "contains"
                        ? text.includes(search)
                        : operator === "starts_with"
                          ? text.startsWith(search)
                          : text.endsWith(search);
                };
            }
        } else if (operator === "eq" || operator === "ne") {
            residual = insensitive && typeof value === "string" && wildcard(value);
            predicate = residual ? undefined : equal(value);
            if (operator === "ne" && predicate) predicate = not(predicate);
            matches = (row) => {
                const actual = row[name];
                const equal =
                    value === null
                        ? actual == null
                        : insensitive && typeof value === "string" && typeof actual === "string"
                          ? actual.toLowerCase() === value.toLowerCase()
                          : actual === value;
                return operator === "eq" ? equal : !equal;
            };
        } else {
            const comparison = { lt, lte, gt, gte }[operator];
            if (!comparison) throw new TypeError("Unsupported authentication predicate.");
            predicate = comparison(key, scalar(value));
        }
        if (
            (attribute?.type === "json" ||
                attribute?.type === "string[]" ||
                attribute?.type === "number[]") &&
            value === null &&
            (operator === "eq" || operator === "ne")
        ) {
            // Object storage only indexes scalar paths; check whole JSON/array
            // absence locally and paginate after that check.
            predicate = undefined;
            residual = true;
            matches = (row) => (operator === "eq" ? row[name] == null : row[name] != null);
        }
        return { clause, predicate, residual, matches };
    });
    const conjunctions = compiled.filter((entry) => entry.clause.connector !== "OR");
    const alternatives = compiled.filter((entry) => entry.clause.connector === "OR");
    const predicates = conjunctions.flatMap((entry) => (entry.predicate ? [entry.predicate] : []));
    if (alternatives.length && alternatives.every((entry) => entry.predicate))
        predicates.push(or(...alternatives.map((entry) => entry.predicate!)));
    const residual = compiled.some((entry) => entry.residual);
    // Residual evaluation uses the same portable evaluator for supported clauses,
    // so pagination never precedes an exact literal recheck.
    return {
        where: predicates.length ? and(...predicates) : undefined,
        residual,
        matches: (row) =>
            conjunctions.every((entry) =>
                entry.residual
                    ? entry.matches!(row)
                    : !entry.predicate ||
                      evaluateQuery([{ key: row.id, value: row }], { where: entry.predicate }).length > 0
            ) &&
            (!alternatives.length ||
                alternatives.some((entry) =>
                    entry.residual
                        ? entry.matches!(row)
                        : !entry.predicate ||
                          evaluateQuery([{ key: row.id, value: row }], { where: entry.predicate }).length > 0
                )),
    };
}
