import { resolveType } from "@party-stack/ontology-spec/utils";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";

/** Sources locate the owning property; the server still authorizes and re-finds
 * the handle there. Copy declared containers so shared handles cannot overwrite
 * another row/property's locator or mutate the underlying storage snapshot.
 * Encrypted contents remain opaque and private device metadata is omitted.
 */
export function withObjectSources(opts: {
    ir: OntologyIR;
    objectType: ObjectTypeDef;
    object: Record<string, unknown>;
    key?: string | number;
}): Record<string, unknown> {
    const primaryKey = opts.key ?? opts.object[opts.objectType.primaryKey];
    if (typeof primaryKey !== "string" && typeof primaryKey !== "number") return opts.object;
    const map = (definition: TypeDef, value: unknown, source: attachment["source"]): unknown => {
        if (value === null || value === undefined) return value;
        const type = resolveType(opts.ir, definition);
        const record = value as Record<string, unknown>;
        switch (type.kind) {
            case "attachment":
                return typeof value === "object" && typeof record.id === "string"
                    ? { ...record, source }
                    : value;
            case "encrypted":
                return typeof value === "object" && typeof record.ciphertext === "string"
                    ? { ciphertext: record.ciphertext, source }
                    : value;
            case "optional":
                return map(type.value.type, value, source);
            case "list":
                return Array.isArray(value)
                    ? value.map((item) => map(type.value.elementType, item, source))
                    : value;
            case "map":
                return typeof value === "object"
                    ? Object.fromEntries(
                          Object.entries(record).map(([key, item]) => [
                              key,
                              map(type.value.valueType, item, source),
                          ])
                      )
                    : value;
            case "struct":
                return typeof value === "object"
                    ? {
                          ...record,
                          ...Object.fromEntries(
                              type.value.fields
                                  .filter((field) => Object.hasOwn(record, field.name))
                                  .map((field) => [field.name, map(field.type, record[field.name], source)])
                          ),
                      }
                    : value;
            case "union": {
                if (typeof value !== "object") return value;
                const variant = type.value.variants.find((variant) => variant.name === record.kind);
                return variant ? { ...record, value: map(variant.type, record.value, source) } : value;
            }
            case "result":
                return typeof value === "object" && (record.kind === "ok" || record.kind === "err")
                    ? {
                          ...record,
                          value: map(
                              record.kind === "ok" ? type.value.okType : type.value.errType,
                              record.value,
                              source
                          ),
                      }
                    : value;
            default:
                return value;
        }
    };
    return {
        ...opts.object,
        ...Object.fromEntries(
            opts.objectType.properties
                .filter((property) => Object.hasOwn(opts.object, property.name))
                .map((property) => [
                    property.name,
                    map(property.type, opts.object[property.name], {
                        objectType: opts.objectType.name,
                        primaryKey,
                        property: property.name,
                    }),
                ])
        ),
    };
}
