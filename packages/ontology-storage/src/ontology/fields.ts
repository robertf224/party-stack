import { validateQuery } from "../query/evaluate.js";
import { filterOperand } from "../query/filter.js";
import type { Field, Filter, Query } from "../model.js";
import type { ObjectStore } from "./model.js";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

/** `true` validates a scalar-array field for `contains`; `"presence"` accepts any declared
 * field, for comparing it with a missing value; `"length"` accepts a list or string field,
 * and `"list"` a list field, for a size index. */
export function validateField(
    ir: OntologyIR,
    object: Pick<ObjectStore<unknown>, "name" | "definition">,
    field: Field,
    mode: boolean | "presence" | "length" | "list" = false
): void {
    const multiEntry = mode === true;
    const visit = (
        type: TypeDef,
        path: readonly string[],
        seen: ReadonlySet<string> = new Set(),
        list = multiEntry
    ): boolean => {
        if (type.kind === "ref") {
            if (seen.has(type.value.name)) throw new TypeError("Circular scalar type reference.");
            const target = ir.types.find((candidate) => candidate.name === type.value.name);
            if (!target) throw new TypeError(`Unknown ontology type ${type.value.name}.`);
            return visit(target.type, path, new Set([...seen, type.value.name]), list);
        }
        if (type.kind === "optional") return visit(type.value.type, path, seen, list);
        if (type.kind === "objectReference") {
            const target = ir.objectTypes.find((candidate) => candidate.name === type.value.objectType);
            const key = target?.properties.find((property) => property.name === target.primaryKey);
            if (!key) throw new TypeError("Invalid object reference primary key.");
            const reference = `object:${type.value.objectType}`;
            if (seen.has(reference)) throw new TypeError("Circular object reference primary key.");
            return visit(key.type, path, new Set([...seen, reference]), list);
        }
        if (!path.length && mode === "presence") return true;
        if (!path.length && mode === "length") return type.kind === "list" || type.kind === "string";
        if (!path.length && mode === "list") return type.kind === "list";
        if (!path.length && list)
            return type.kind === "list" && visit(type.value.elementType, [], seen, false);
        if (!path.length)
            return ["string", "boolean", "integer", "float", "double", "date", "timestamp"].includes(
                type.kind
            );
        const [name, ...rest] = path;
        if (type.kind === "struct") {
            const field = type.value.fields.find((field) => field.name === name);
            return field !== undefined && visit(field.type, rest, seen, list);
        }
        if (type.kind === "map") return visit(type.value.valueType, rest, seen, list);
        if (type.kind === "list" && /^(0|[1-9][0-9]*)$/.test(name!))
            return visit(type.value.elementType, rest, seen, list);
        if (type.kind === "result")
            return visit(
                {
                    kind: "union",
                    value: {
                        variants: [
                            { name: "ok", type: type.value.okType },
                            { name: "err", type: type.value.errType },
                        ],
                    },
                },
                path,
                seen,
                list
            );
        if (type.kind === "union") {
            if (name === "kind") return !list && rest.length === 0;
            return (
                name === "value" &&
                type.value.variants.every((variant) => visit(variant.type, rest, seen, list))
            );
        }
        if (type.kind === "attachment" || type.kind === "encrypted") {
            if (name === "id" || (type.kind === "attachment" && name === "type"))
                return !list && rest.length === 0;
            return (
                !list &&
                name === "source" &&
                rest.length === 1 &&
                ["objectType", "primaryKey", "property"].includes(rest[0]!)
            );
        }
        if (type.kind === "geopoint") return !list && rest.length === 0 && (name === "lat" || name === "lon");
        return false;
    };
    if (
        !field.path.length ||
        !visit({ kind: "struct", value: { fields: object.definition.properties } }, field.path)
    )
        throw new TypeError(
            `Expected a declared ${mode === "presence" ? "" : mode === "length" ? "list or string " : mode === "list" ? "list " : multiEntry ? "scalar-array " : "scalar "}field on ${object.name}: ${JSON.stringify(field.path)}.`
        );
}
export function validateObjectQuery(ir: OntologyIR, object: ObjectStore<unknown>, query: Query): void {
    validateQuery(query);
    const visit = (value: Filter): void => {
        if (value.kind === "and" || value.kind === "or") return value.value.expressions.forEach(visit);
        if (value.kind === "not") return visit(value.value.expression);
        if (!("left" in value.value)) return;
        const left = filterOperand(value.value.left);
        const right = filterOperand(value.value.right);
        // Comparing with a missing value checks presence, so any declared field qualifies.
        const presence = (other: typeof left) =>
            (value.kind === "eq" || value.kind === "ne") && other?.kind === "literal" && other.value == null
                ? ("presence" as const)
                : false;
        for (const [operand, mode] of [
            [left, value.kind === "contains" || presence(right)],
            [right, presence(left)],
        ] as const) {
            if (operand?.kind === "field") validateField(ir, object, operand.field, mode);
            else if (operand?.kind === "length") validateField(ir, object, operand.field, "length");
        }
    };
    if (query.where) visit(query.where);
    query.orderBy?.forEach((order) => validateField(ir, object, order.field));
}
