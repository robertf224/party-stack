import { field } from "@party-stack/ontology-storage";
import { isField } from "@party-stack/ontology-storage/tables";
import { IR } from "@tanstack/db";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { Operand, Order, Predicate, Query, Scalar } from "@party-stack/ontology-storage";
import type { LoadSubsetOptions } from "@tanstack/db";

type Definition = ReplicaService["ir"]["types"][number]["type"];
type Family = "string" | "number" | "boolean" | "date" | "timestamp";
interface Value {
    operand: Operand;
    family?: Family;
    elementFamily?: Family;
    optional: boolean;
}
type Condition = Predicate | boolean;
interface Truth {
    yes: Condition;
    no: Condition;
    exact: boolean;
}
const unknown: Truth = { yes: true, no: true, exact: false };
const combine = (op: "and" | "or", values: readonly Condition[]): Condition => {
    const terminal = op === "or";
    if (values.includes(terminal)) return terminal;
    const predicates = values.filter((value): value is Predicate => typeof value !== "boolean");
    return predicates.length === 0
        ? !terminal
        : predicates.length === 1
          ? predicates[0]!
          : { op, predicates };
};
const predicate = (value: Condition): Predicate | undefined =>
    value === true ? undefined : value === false ? { op: "or", predicates: [] } : value;
const negate = (value: Condition): Condition =>
    typeof value === "boolean" ? !value : { op: "not", predicate: value };

/** Translate only semantics that storage can preserve. Unsupported expressions
 * widen demand; TanStack still evaluates the original query on the returned rows.
 * In particular, a residual filter or locale comparator must run before LIMIT.
 */
export function analyzeStorageSubset(
    subset: LoadSubsetOptions,
    ir?: ReplicaService["ir"],
    objectType?: string
) {
    const objects = new Map(ir?.objectTypes.map((type) => [type.name, type]));
    const named = new Map(ir?.types.map((type) => [type.name, type.type]));
    const resolve = (
        type: Definition | undefined,
        path: readonly string[],
        optional = false,
        seen = new Set<Definition>()
    ): Omit<Value, "operand"> | undefined => {
        if (!type || seen.has(type)) return undefined;
        const next = new Set([...seen, type]);
        if (type.kind === "optional") return resolve(type.value.type, path, true, next);
        if (type.kind === "ref") return resolve(named.get(type.value.name), path, optional, next);
        if (type.kind === "objectReference") {
            const object = objects.get(type.value.objectType);
            return resolve(
                object?.properties.find((prop) => prop.name === object.primaryKey)?.type,
                path,
                optional,
                next
            );
        }
        if (path.length)
            return type.kind === "struct"
                ? resolve(
                      type.value.fields.find((prop) => prop.name === path[0])?.type,
                      path.slice(1),
                      optional,
                      next
                  )
                : undefined;
        if (type.kind === "list")
            return { elementFamily: resolve(type.value.elementType, [], false, next)?.family, optional };
        switch (type.kind) {
            case "string":
            case "boolean":
            case "date":
            case "timestamp":
                return { family: type.kind, optional };
            case "integer":
            case "float":
            case "double":
                return { family: "number", optional };
            default:
                return undefined;
        }
    };
    const value = (expression: IR.BasicExpression): Value | undefined => {
        if (expression.type === "ref") {
            const path = IR.getPropRefPropertyPath(expression);
            if (!path.length) return undefined;
            const type = objects
                .get(objectType ?? "")
                ?.properties.find((prop) => prop.name === path[0])?.type;
            const resolved = resolve(type, path.slice(1));
            return resolved && { operand: field(...path), ...resolved };
        }
        if (expression.type !== "val") return undefined;
        const literal: unknown = expression.value;
        if (literal == null) return { operand: literal, optional: true };
        if (typeof literal === "string" || typeof literal === "boolean")
            return { operand: literal, family: typeof literal as "string" | "boolean", optional: false };
        if (typeof literal === "number" && Number.isFinite(literal))
            return { operand: literal, family: "number", optional: false };
        if (typeof literal === "object") {
            const tag = Reflect.get(literal, Symbol.toStringTag) as unknown;
            if (tag === "Temporal.Instant" || tag === "Temporal.PlainDate")
                return {
                    operand: literal as Scalar,
                    family: tag === "Temporal.Instant" ? "timestamp" : "date",
                    optional: false,
                };
        }
        return undefined;
    };
    const present = (v: Value): Condition =>
        !v.optional
            ? true
            : isField(v.operand)
              ? // Ontology object decoding normalizes optional nulls to undefined.
                { op: "ne", left: v.operand, right: undefined }
              : false;
    const truth = (expression: IR.BasicExpression): Truth => {
        if (expression.type === "val" && (typeof expression.value === "boolean" || expression.value == null))
            return {
                yes: expression.value === true,
                no: expression.value === false,
                exact: true,
            };
        if (expression.type === "ref") {
            const v = value(expression);
            return v?.family === "boolean"
                ? {
                      yes: { op: "eq", left: v.operand, right: true },
                      no: { op: "eq", left: v.operand, right: false },
                      exact: true,
                  }
                : unknown;
        }
        if (expression.type !== "func") return unknown;
        const { name, args } = expression;
        if (name === "and" || name === "or") {
            const children = args.map(truth);
            return {
                yes: combine(
                    name,
                    children.map((c) => c.yes)
                ),
                no: combine(
                    name === "and" ? "or" : "and",
                    children.map((c) => c.no)
                ),
                exact: children.every((c) => c.exact),
            };
        }
        if (name === "not" && args.length === 1) {
            const child = truth(args[0]!);
            return { yes: child.no, no: child.yes, exact: child.exact };
        }
        const left = args[0] && value(args[0]);
        if (!left) return unknown;
        if ((name === "isNull" || name === "isUndefined") && args.length === 1) {
            const yes: Predicate = {
                op: "eq",
                left: left.operand,
                right: name === "isNull" ? null : undefined,
            };
            return { yes, no: negate(yes), exact: true };
        }
        if (name === "in" && args[1]?.type === "ref") {
            const array = value(args[1]);
            if (!array?.elementFamily || !isField(array.operand)) return unknown;
            if (!left.family) return { yes: false, no: false, exact: true };
            if (left.family !== array.elementFamily) return unknown;
            const yes: Predicate = { op: "contains", left: array.operand, right: left.operand };
            return {
                yes: combine("and", [present(left), yes]),
                no: combine("and", [present(left), negate(yes)]),
                exact: true,
            };
        }
        if (name === "in" && args[1]?.type === "val" && Array.isArray(args[1].value)) {
            const items = (args[1].value as unknown[])
                .filter((item) => item != null)
                .map((item) => value(new IR.Value(item)));
            if (items.some((item) => !item || item.family !== left.family)) return unknown;
            const yes: Predicate = {
                op: "in",
                left: left.operand,
                values: items.map((item) => item!.operand as Scalar),
            };
            return {
                yes: combine("and", [present(left), yes]),
                no: combine("and", [present(left), negate(yes)]),
                exact: true,
            };
        }
        if (!["eq", "gt", "gte", "lt", "lte", "like", "ilike"].includes(name)) return unknown;
        const right = args[1] && value(args[1]);
        if (!right || args.length !== 2) return unknown;
        if (!left.family || !right.family) return { yes: false, no: false, exact: true };
        if (left.family !== right.family) return unknown;
        const guard = combine("and", [present(left), present(right)]);
        let yes: Predicate;
        if (name === "eq" || name === "gt" || name === "gte" || name === "lt" || name === "lte")
            yes = { op: name, left: left.operand, right: right.operand };
        else if ((name === "like" || name === "ilike") && left.family === "string")
            yes = { op: name, left: left.operand, right: right.operand as string | ReturnType<typeof field> };
        else return unknown;
        // Equality against a defined operand already rejects missing values. Two
        // optional operands can both be missing and still compare equal in storage.
        // Negation always needs the guard: TanStack treats missing as UNKNOWN,
        // whereas storage's NOT turns an ordinary false comparison into true.
        return {
            yes: name === "eq" && (!left.optional || !right.optional) ? yes : combine("and", [guard, yes]),
            no: combine("and", [guard, negate(yes)]),
            exact: true,
        };
    };
    const filter = subset.where ? truth(subset.where) : { yes: true, exact: true };
    // Load the entire leading-value tie on cursor requests. A local lastKey
    // does not prove remote coverage for a composite ordering boundary.
    const cursor = subset.cursor
        ? truth(new IR.Func("or", [subset.cursor.whereFrom, subset.cursor.whereCurrent]))
        : undefined;
    const orderBy: Order[] = [];
    let ordered = true;
    for (const order of subset.orderBy ?? []) {
        const v = value(order.expression);
        const compare = order.compareOptions;
        if (
            order.expression.type !== "ref" ||
            !v ||
            compare.stringSort === "custom" ||
            (v.family === "string" && compare.stringSort !== "lexical")
        ) {
            ordered = false;
            break;
        }
        orderBy.push({
            field: v.operand as ReturnType<typeof field>,
            direction: compare.direction,
            nulls: compare.nulls,
        });
    }
    const bounded = filter.exact && ordered && !cursor;
    const limit = bounded && subset.limit !== undefined ? subset.limit + (subset.offset ?? 0) : undefined;
    const query: Query = {
        where: predicate(combine("and", [filter.yes, cursor?.yes ?? true])),
        ...(ordered && orderBy.length ? { orderBy } : {}),
        ...(limit !== undefined && Number.isSafeInteger(limit) ? { limit } : {}),
    };
    return {
        query,
        exact: filter.exact && ordered && !cursor,
        filterExact: filter.exact,
        orderExact: ordered,
    };
}

export function storageSubset(
    subset: LoadSubsetOptions,
    ir?: ReplicaService["ir"],
    objectType?: string
): Query {
    return analyzeStorageSubset(subset, ir, objectType).query;
}
