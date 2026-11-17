import { resolveType } from "@party-stack/ontology-spec/utils";
import { isField } from "@party-stack/ontology-storage/tables";
import type { PropertyIdentifier, SearchJsonQueryV2 } from "@osdk/foundry.ontologies";
import type { SourceQueryPlan } from "@party-stack/ontology-backend";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology-spec";
import type { Field, Predicate, Scalar } from "@party-stack/ontology-storage";

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

/** `left == undefined` with the field on either side. */
const missing = (predicate: Predicate): Field | undefined => {
    if (predicate.op !== "eq") return;
    const [field, other] = isField(predicate.left)
        ? [predicate.left, predicate.right]
        : [predicate.right, predicate.left];
    return isField(field) && !isField(other) && other === undefined ? field : undefined;
};

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
 *   answers "missing or empty" exactly, and either alone as a superset.
 */
function translate(
    predicate: Predicate,
    arrays: ArrayProperties,
    recurse: (predicate: Predicate) => Translation | undefined
): Translation | undefined {
    if (predicate.op === "or") {
        // Missing or empty, the lowering of `length(list) == 0`.
        const fields = predicate.predicates.map((child) =>
            child.op === "empty" ? child.left : missing(child)
        );
        const name = fields[0] && property(fields[0]);
        if (
            predicate.predicates.length === 2 &&
            name !== undefined &&
            arrays.has(name) &&
            fields.every((field) => field && property(field) === name) &&
            predicate.predicates.some((child) => child.op === "empty")
        )
            return { query: isNull(name, true), exact: true };
    }
    if (predicate.op === "and" || predicate.op === "or") {
        const children = predicate.predicates.map(recurse);
        if (predicate.op === "or" && children.some((child) => !child)) return;
        const sent = children.filter((child): child is Translation => child !== undefined);
        if (!sent.length) return;
        return {
            query: { type: predicate.op, value: sent.map((child) => child.query) },
            exact: sent.length === children.length && sent.every((child) => child.exact),
        };
    }
    if (predicate.op === "not" || predicate.op === "ne") {
        const inner = recurse(
            predicate.op === "not" ? predicate.predicate : { ...predicate, op: "eq" as const }
        );
        return inner?.exact ? { query: { type: "not", value: inner.query }, exact: true } : undefined;
    }
    if (predicate.op === "empty") {
        const name = property(predicate.left);
        // A required array is never missing, so `isNull` is exactly "empty".
        return name && arrays.has(name) ? { query: isNull(name, true), exact: arrays.get(name)! } : undefined;
    }
    const absent = missing(predicate);
    if (absent) {
        const name = property(absent);
        if (!name) return;
        return { query: isNull(name, true), exact: !arrays.has(name) };
    }
    if (predicate.op === "like" || predicate.op === "ilike") {
        if (!isField(predicate.left) || typeof predicate.right !== "string") return;
        return likeFilter(predicate.left, predicate.right, predicate.op === "ilike");
    }
    if (predicate.op === "contains") {
        const name = property(predicate.left);
        if (
            !name ||
            isField(predicate.right) ||
            predicate.right == null ||
            typeof predicate.right === "bigint"
        )
            return;
        return { query: { type: "contains", field: name, value: scalar(predicate.right) }, exact: true };
    }
    if (predicate.op === "in") {
        const name = isField(predicate.left) ? property(predicate.left) : undefined;
        if (!name || predicate.values.some((value) => value == null || typeof value === "bigint")) return;
        return { query: { type: "in", field: name, value: predicate.values.map(scalar) }, exact: true };
    }
    let { left, right, op } = predicate;
    if (isField(right) && !isField(left)) {
        [left, right] = [right, left];
        op = ({ eq: "eq", gt: "lt", gte: "lte", lt: "gt", lte: "gte" } as const)[op];
    }
    const name = isField(left) ? property(left) : undefined;
    if (!name || arrays.has(name) || isField(right) || right == null || typeof right === "bigint") return;
    const query: SearchJsonQueryV2 = { type: op, field: name, value: scalar(right) };
    // Storage orders a missing value before every other value; Foundry's ranges exclude null.
    return {
        query: op === "lt" || op === "lte" ? { type: "or", value: [query, isNull(name, true)] } : query,
        exact: true,
    };
}

export const subsetFilter = (
    predicate: Predicate | undefined,
    arrays: ArrayProperties = new Map()
): SearchJsonQueryV2 | undefined => {
    const recurse = (child: Predicate): Translation | undefined => translate(child, arrays, recurse);
    return predicate ? recurse(predicate)?.query : undefined;
};

/** Report effective placement, including supported OR branches that could not safely be sent. */
export function analyzeSubsetFilter(predicate: Predicate | undefined, arrays: ArrayProperties = new Map()) {
    const translated = new Map<Predicate, Translation | undefined>();
    const visit = (predicate: Predicate): Translation | undefined => {
        const result = translate(predicate, arrays, visit);
        translated.set(predicate, result);
        return result;
    };
    const query = predicate ? visit(predicate)?.query : undefined;
    const predicates: SourceQueryPlan["predicates"][number][] = [];
    const report = (predicate: Predicate, path: readonly number[], allowed: boolean, exact = false): void => {
        const result = allowed ? translated.get(predicate) : undefined;
        // Everything under an exact filter is answered by Foundry, including terms
        // translated together rather than one by one.
        const whole = exact || result?.exact === true;
        if (predicate.op === "and" || predicate.op === "or")
            predicate.predicates.forEach((child, index) =>
                report(child, [...path, index], result !== undefined, whole)
            );
        else if (predicate.op === "not")
            report(predicate.predicate, [...path, 0], result !== undefined, whole);
        else
            predicates.push({
                path,
                execution: whole ? "source" : result ? "candidate" : "adapter",
            });
    };
    if (predicate) report(predicate, [], true);
    return { query, predicates };
}
