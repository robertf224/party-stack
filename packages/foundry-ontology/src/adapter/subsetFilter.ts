import { resolveType } from "@party-stack/ontology-spec/utils";
import {
    filterOperand,
    inValues,
    lengthComparison,
    lengthEmptiness,
} from "@party-stack/ontology-storage/tables";
import type { PropertyIdentifier, SearchJsonQueryV2 } from "@osdk/foundry.ontologies";
import type { SourceQueryPlan } from "@party-stack/ontology-backend";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology-spec";
import type { Field, Filter, FilterOperand, Scalar } from "@party-stack/ontology-storage";

/** A Foundry filter, and whether it returns exactly the matching rows rather than a superset. */
interface Translation {
    readonly query: SearchJsonQueryV2;
    readonly exact: boolean;
}

/** Array properties by name, `true` when the property is required. Foundry's `isNull` is
 * true for an empty array as well as a missing one, so arrays need their own rules. */
export type ArrayProperties = ReadonlyMap<string, boolean>;

export function arrayProperties(ir: OntologyIR, definition: ObjectTypeDef): ArrayProperties {
    const list = (type: TypeDef, required = true): boolean | undefined => {
        const resolved = resolveType(ir, type);
        if (resolved.kind === "optional") return list(resolved.value.type, false);
        return resolved.kind === "list" ? required : undefined;
    };
    const arrays = new Map<string, boolean>();
    for (const property of definition.properties) {
        const required = list(property.type);
        if (required !== undefined) arrays.set(property.name, required);
    }
    return arrays;
}

const scalar = (value: Scalar): unknown =>
    value instanceof Date
        ? value.toISOString()
        : typeof value === "object" && value !== null && "toString" in value
          ? value.toString()
          : value;

const property = (field: Field): string | undefined => (field.path.length === 1 ? field.path[0] : undefined);
const propertyIdentifier = (field: Field): PropertyIdentifier | undefined =>
    field.path.length === 1
        ? { type: "property", apiName: field.path[0]! }
        : field.path.length === 2
          ? { type: "structField", propertyApiName: field.path[0]!, structFieldApiName: field.path[1]! }
          : undefined;
const isNull = (name: string, value: boolean): SearchJsonQueryV2 => ({ type: "isNull", field: name, value });

/** `field == undefined` with the field on either side. */
const missing = (filter: Filter): Field | undefined => {
    if (filter.kind !== "eq") return;
    const left = filterOperand(filter.value.left);
    const right = filterOperand(filter.value.right);
    const [field, other] = left?.kind === "field" ? [left, right] : [right, left];
    return field?.kind === "field" && other?.kind === "literal" && other.value === undefined
        ? field.field
        : undefined;
};
/** A present scalar literal that Foundry can compare against. */
const sendable = (operand: FilterOperand | undefined): operand is { kind: "literal"; value: Scalar } =>
    operand?.kind === "literal" && operand.value != null && typeof operand.value !== "bigint";

/** Foundry matches `wildcard` against each lowercased token of a string: `*` cannot lead,
 * and a pattern cannot span spaces or punctuation. A LIKE pattern that starts with a word
 * is sent as that word's prefix, which the value's first token must start with. The
 * result is a superset; patterns that start with a wildcard or punctuation stay local. */
function likeFilter(field: Field, pattern: string, insensitive: boolean): Translation | undefined {
    const identifier = propertyIdentifier(field);
    if (!identifier) return;
    const name = property(field);
    if (!insensitive && name && !/[%_]/.test(pattern))
        return { query: { type: "eq", field: name, value: pattern }, exact: true };
    const word = /^[a-z0-9]+/.exec(pattern.toLowerCase())?.[0];
    if (!word) return;
    return { query: { type: "wildcard", propertyIdentifier: identifier, value: `${word}*` }, exact: false };
}

/** Filters Foundry can answer, shared by HTTP reads and WebSocket watches. Unsupported
 * terms broaden membership; sort, limit and cursors stay local so watches include future
 * window entrants. Behaviour was checked against Foundry's search API:
 * - `eq`, `in`, `contains` and ranges compare like storage. Strings compare case-sensitively,
 *   and ranges exclude null.
 * - `not` is a plain complement that includes null, as storage's is. It is sent only over an
 *   exact filter, since negating a superset would drop rows.
 * - `isNull` is exact for scalars. On arrays it is also true for an empty array, so it
 *   answers `length(array) == 0` (missing or empty) exactly, and a missing check alone as a
 *   superset. Other array lengths and every string length stay local.
 */
function translate(
    filter: Filter,
    arrays: ArrayProperties,
    recurse: (filter: Filter) => Translation | undefined
): Translation | undefined {
    if (filter.kind === "and" || filter.kind === "or") {
        const children = filter.value.expressions.map(recurse);
        if (filter.kind === "or" && children.some((child) => !child)) return;
        const sent = children.filter((child): child is Translation => child !== undefined);
        if (!sent.length) return;
        return {
            query: { type: filter.kind, value: sent.map((child) => child.query) },
            exact: sent.length === children.length && sent.every((child) => child.exact),
        };
    }
    if (filter.kind === "not" || filter.kind === "ne") {
        const inner = recurse(filter.kind === "not" ? filter.value.expression : { ...filter, kind: "eq" });
        return inner?.exact ? { query: { type: "not", value: inner.query }, exact: true } : undefined;
    }
    // `length(array)` against a bound that only distinguishes empty from nonempty. Foundry's
    // `isNull` is true for a missing or empty array, which is exactly a length of 0.
    const counted = lengthComparison(filter);
    if (counted) {
        const name = property(counted.field);
        const empty = lengthEmptiness(counted.op, counted.bound);
        // String lengths stay local.
        if (!name || !arrays.has(name) || empty === undefined) return;
        return {
            query: empty ? isNull(name, true) : { type: "not", value: isNull(name, true) },
            exact: true,
        };
    }
    const absent = missing(filter);
    if (absent) {
        const name = property(absent);
        if (!name) return;
        return { query: isNull(name, true), exact: !arrays.has(name) };
    }
    if (!("left" in filter.value)) return;
    const left = filterOperand(filter.value.left);
    const right = filterOperand(filter.value.right);
    if (filter.kind === "like" || filter.kind === "ilike") {
        if (left?.kind !== "field" || right?.kind !== "literal" || typeof right.value !== "string") return;
        return likeFilter(left.field, right.value, filter.kind === "ilike");
    }
    if (filter.kind === "contains") {
        const name = left?.kind === "field" ? property(left.field) : undefined;
        if (!name || !sendable(right)) return;
        return { query: { type: "contains", field: name, value: scalar(right.value) }, exact: true };
    }
    if (filter.kind === "in") {
        const name = left?.kind === "field" ? property(left.field) : undefined;
        const values = inValues(filter);
        if (!name || values.some((value) => value == null || typeof value === "bigint")) return;
        return {
            query: { type: "in", field: name, value: values.map((value) => scalar(value as Scalar)) },
            exact: true,
        };
    }
    if (
        filter.kind !== "eq" &&
        filter.kind !== "lt" &&
        filter.kind !== "lte" &&
        filter.kind !== "gt" &&
        filter.kind !== "gte"
    )
        return;
    const flipped = { eq: "eq", gt: "lt", gte: "lte", lt: "gt", lte: "gte" } as const;
    const [field, value, op] =
        left?.kind === "field" ? [left, right, filter.kind] : [right, left, flipped[filter.kind]];
    const name = field?.kind === "field" ? property(field.field) : undefined;
    if (!name || arrays.has(name) || !sendable(value)) return;
    const query: SearchJsonQueryV2 = { type: op, field: name, value: scalar(value.value) };
    // Storage orders a missing value before every other value; Foundry's ranges exclude null.
    return {
        query: op === "lt" || op === "lte" ? { type: "or", value: [query, isNull(name, true)] } : query,
        exact: true,
    };
}

export const subsetFilter = (
    filter: Filter | undefined,
    arrays: ArrayProperties = new Map()
): SearchJsonQueryV2 | undefined => {
    const recurse = (child: Filter): Translation | undefined => translate(child, arrays, recurse);
    return filter ? recurse(filter)?.query : undefined;
};

/** Report effective placement, including supported OR branches that could not safely be sent. */
export function analyzeSubsetFilter(predicate: Filter | undefined, arrays: ArrayProperties = new Map()) {
    const translated = new Map<Filter, Translation | undefined>();
    const visit = (predicate: Filter): Translation | undefined => {
        const result = translate(predicate, arrays, visit);
        translated.set(predicate, result);
        return result;
    };
    const query = predicate ? visit(predicate)?.query : undefined;
    const predicates: SourceQueryPlan["predicates"][number][] = [];
    const report = (predicate: Filter, path: readonly number[], allowed: boolean, exact = false): void => {
        const result = allowed ? translated.get(predicate) : undefined;
        // Everything under an exact filter is answered by Foundry, including terms
        // translated together rather than one by one.
        const whole = exact || result?.exact === true;
        if (predicate.kind === "and" || predicate.kind === "or")
            predicate.value.expressions.forEach((child, index) =>
                report(child, [...path, index], result !== undefined, whole)
            );
        else if (predicate.kind === "not")
            report(predicate.value.expression, [...path, 0], result !== undefined, whole);
        else
            predicates.push({
                path,
                execution: whole ? "source" : result ? "candidate" : "adapter",
            });
    };
    if (predicate) report(predicate, [], true);
    return { query, predicates };
}
