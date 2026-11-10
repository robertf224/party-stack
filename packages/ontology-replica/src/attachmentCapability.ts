import type { OntologyIR, TypeDef } from "@party-stack/ontology-spec";

/** Object types whose declared, non-opaque value structure can own attachment
 * handles. Schema metadata only: this never examines or caches application rows.
 * Keep traversal aligned with collectAttachments in ontology-storage/blobs.
 */
export function objectTypesWithAttachments(ir: OntologyIR): ReadonlySet<string> {
    const definitions = new Map(ir.types.map((entry) => [entry.name, entry.type]));
    const canContain = (initial: readonly TypeDef[]) => {
        const pending = [...initial];
        const visited = new Set<string>();
        while (pending.length) {
            const type = pending.pop()!;
            switch (type.kind) {
                case "attachment":
                    return true;
                case "ref": {
                    const name = type.value.name;
                    if (visited.has(name)) break;
                    visited.add(name);
                    const value = definitions.get(name);
                    // Invalid/unknown definitions must not enable a skip path.
                    if (!value) return true;
                    pending.push(value);
                    break;
                }
                case "optional":
                    pending.push(type.value.type);
                    break;
                case "list":
                    pending.push(type.value.elementType);
                    break;
                case "map":
                    // Map keys are not attachment-owning values in the collector.
                    pending.push(type.value.valueType);
                    break;
                case "struct":
                    pending.push(...type.value.fields.map((field) => field.type));
                    break;
                case "union":
                    pending.push(...type.value.variants.map((variant) => variant.type));
                    break;
                case "result":
                    pending.push(type.value.okType, type.value.errType);
                    break;
                case "encrypted":
                case "objectReference":
                case "unknown":
                case "string":
                case "boolean":
                case "integer":
                case "float":
                case "double":
                case "date":
                case "timestamp":
                case "geopoint":
                    // The collector never traverses these values, including an
                    // encrypted plaintext schema or an object reference's target.
                    break;
                default: {
                    // A future IR variant needs an explicit traversal decision.
                    const exhaustive: never = type;
                    void exhaustive;
                    return true;
                }
            }
        }
        return false;
    };
    return new Set(
        ir.objectTypes
            .filter((type) => canContain(type.properties.map((property) => property.type)))
            .map((type) => type.name)
    );
}
