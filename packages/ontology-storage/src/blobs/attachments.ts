import { resolveType } from "@party-stack/ontology-spec/utils";
import { Predicate } from "effect";
import type { AttachmentTypeDef, OntologyIR, TypeDef } from "@party-stack/ontology-spec";
import type { attachment } from "@party-stack/ontology-spec/values";

export interface AttachmentReference {
    readonly attachment: attachment;
    readonly target: AttachmentTypeDef;
}

/** Follow declared value structure only; references and encrypted values remain opaque. */
export function collectAttachments(
    ir: OntologyIR,
    definition: TypeDef,
    value: unknown
): AttachmentReference[] {
    if (value === null || value === undefined) return [];
    const type = resolveType(ir, definition);
    switch (type.kind) {
        case "attachment":
            return Predicate.isObject(value) && typeof value.id === "string"
                ? [{ attachment: value as attachment, target: type.value }]
                : [];
        case "optional":
            return collectAttachments(ir, type.value.type, value);
        case "list":
            return Array.isArray(value)
                ? value.flatMap((item) => collectAttachments(ir, type.value.elementType, item))
                : [];
        case "map":
            return Predicate.isObject(value)
                ? Object.values(value).flatMap((item) => collectAttachments(ir, type.value.valueType, item))
                : [];
        case "struct":
            return Predicate.isObject(value)
                ? type.value.fields.flatMap((field) => collectAttachments(ir, field.type, value[field.name]))
                : [];
        case "union": {
            if (!Predicate.isObject(value)) return [];
            const variant = type.value.variants.find((variant) => variant.name === value.kind);
            return variant ? collectAttachments(ir, variant.type, value.value) : [];
        }
        case "result":
            return Predicate.isObject(value) && (value.kind === "ok" || value.kind === "err")
                ? collectAttachments(
                      ir,
                      value.kind === "ok" ? type.value.okType : type.value.errType,
                      value.value
                  )
                : [];
        default:
            return [];
    }
}

export function collectActionAttachments(
    ir: OntologyIR,
    name: string,
    parameters: Record<string, unknown>
): AttachmentReference[] {
    const action = ir.actionTypes.find((action) => action.name === name);
    if (!action) throw new TypeError("Unknown action type.");
    const entries = action.parameters.flatMap((parameter) =>
        collectAttachments(ir, parameter.type, parameters[parameter.name])
    );
    return [...new Map(entries.map((entry) => [entry.attachment.id, entry])).values()];
}
