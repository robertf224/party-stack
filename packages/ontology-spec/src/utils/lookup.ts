import type { Expression, FieldDef, OntologyIR, TypeDef } from "../ir/generated/types.js";

/** LOOKUP accepts explicit input/context reference paths. Row relationships use
 * related; a scalar foreign key is not implicitly an object-reference property. */
export function resolveLookupReference(
    ir: OntologyIR,
    expression: Expression,
    inputs: readonly FieldDef[] = []
): { objectType: string; optional: boolean } | undefined {
    let node = expression;
    let path: string[] = [];
    while (node.kind === "getAt") {
        path = [...node.value.path, ...path];
        node = node.value.source;
    }
    let optional = false;
    const resolve = (value: TypeDef | undefined, seen = new Set<string>()): TypeDef | undefined => {
        if (value?.kind === "optional") {
            optional = true;
            return resolve(value.value.type, seen);
        }
        if (value?.kind !== "ref") return value;
        if (seen.has(value.value.name)) return undefined;
        return resolve(
            ir.types.find((t) => t.name === value.value.name)?.type,
            new Set([...seen, value.value.name])
        );
    };
    let type =
        node.kind === "inputReference"
            ? inputs.find((field) => field.name === node.value.name)?.type
            : node.kind === "contextReference"
              ? ir.context?.type
              : undefined;
    if (node.kind === "contextReference") path.unshift(node.value.name);
    for (const name of path) {
        const source = resolve(type);
        type =
            source?.kind === "struct"
                ? source.value.fields.find((field) => field.name === name)?.type
                : undefined;
    }
    type = resolve(type);
    return type?.kind === "objectReference" ? { objectType: type.value.objectType, optional } : undefined;
}
