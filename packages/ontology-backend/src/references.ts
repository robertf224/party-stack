import { resolveType } from "@party-stack/ontology-spec/utils";
import { Effect, Predicate } from "effect";
import type { ValidationIssue } from "./errors.js";
import type { OwnedReadTransaction } from "./owned.js";
import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

type Reference = { objectType: string; key: string | number; path: readonly (string | number)[] };
// Values have already passed the parameter codec. Only declared references are traversed.
function references(
    ir: OntologyIR,
    definition: TypeDef,
    value: unknown,
    path: Reference["path"]
): Reference[] {
    if (value === null || value === undefined) return [];
    const type = resolveType(ir, definition);
    switch (type.kind) {
        case "objectReference":
            return [{ objectType: type.value.objectType, key: value as string | number, path }];
        case "optional":
            return references(ir, type.value.type, value, path);
        case "list":
            return Array.isArray(value)
                ? value.flatMap((item, index) =>
                      references(ir, type.value.elementType, item, [...path, index])
                  )
                : [];
        case "map":
            return Predicate.isObject(value)
                ? Object.entries(value).flatMap(([key, item]) =>
                      references(ir, type.value.valueType, item, [...path, key])
                  )
                : [];
        case "struct":
            return Predicate.isObject(value)
                ? type.value.fields.flatMap((field) =>
                      references(ir, field.type, value[field.name], [...path, field.name])
                  )
                : [];
        case "union": {
            if (!Predicate.isObject(value)) return [];
            const variant = type.value.variants.find((variant) => variant.name === value.kind);
            return variant ? references(ir, variant.type, value.value, [...path, "value"]) : [];
        }
        case "result":
            return Predicate.isObject(value) && (value.kind === "ok" || value.kind === "err")
                ? references(ir, value.kind === "ok" ? type.value.okType : type.value.errType, value.value, [
                      ...path,
                      "value",
                  ])
                : [];
        default:
            return [];
    }
}
export const actionReferenceIssues = Effect.fnUntraced(function* (
    ir: OntologyIR,
    parameters: OntologyIR["actionTypes"][number]["parameters"],
    values: Record<string, unknown>,
    tx: OwnedReadTransaction
) {
    const issues: ValidationIssue[] = [];
    for (const parameter of parameters)
        for (const ref of references(ir, parameter.type, values[parameter.name], [parameter.name]))
            if (!(yield* tx.get(ref.objectType, ref.key)))
                issues.push({
                    path: ref.path,
                    code: "InvalidObjectReference",
                    category: "reference",
                    source: "parameter",
                    messageSource: "standard",
                    message: "Choose a valid value. The referenced object is no longer available.",
                });
    return issues;
});
