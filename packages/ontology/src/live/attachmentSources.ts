import { resolveType } from "../utils/types.js";
import type { ObjectTypeDef, OntologyIR, TypeDef } from "../ir/index.js";
import type { attachment } from "../utils/values.js";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isAttachment(value: unknown): value is attachment {
    return isRecord(value) && typeof value.id === "string";
}

function decorateAttachmentValue(opts: {
    ir: OntologyIR;
    type: TypeDef;
    value: unknown;
    source: NonNullable<attachment["source"]>;
}) {
    if (opts.value === undefined || opts.value === null) return;

    const type = resolveType(opts.ir, opts.type);
    switch (type.kind) {
        case "attachment":
            if (isAttachment(opts.value)) {
                opts.value.source = opts.source;
            }
            return;
        case "optional":
            decorateAttachmentValue({
                ...opts,
                type: type.value.type,
            });
            return;
        case "list":
            if (Array.isArray(opts.value)) {
                for (const item of opts.value) {
                    decorateAttachmentValue({
                        ...opts,
                        type: type.value.elementType,
                        value: item,
                    });
                }
            }
            return;
        case "map":
            if (isRecord(opts.value)) {
                for (const item of Object.values(opts.value)) {
                    decorateAttachmentValue({
                        ...opts,
                        type: type.value.valueType,
                        value: item,
                    });
                }
            }
            return;
        case "struct":
            if (isRecord(opts.value)) {
                for (const field of type.value.fields) {
                    decorateAttachmentValue({
                        ...opts,
                        type: field.type,
                        value: opts.value[field.name],
                    });
                }
            }
            return;
        default:
            return;
    }
}

export function decorateObjectAttachmentSources(opts: {
    ir: OntologyIR;
    objectType: ObjectTypeDef;
    object: Record<string, unknown>;
}): Record<string, unknown> {
    const primaryKey = opts.object[opts.objectType.primaryKey];
    if (typeof primaryKey !== "string" && typeof primaryKey !== "number") {
        return opts.object;
    }

    for (const property of opts.objectType.properties) {
        decorateAttachmentValue({
            ir: opts.ir,
            type: property.type,
            value: opts.object[property.name],
            source: {
                objectType: opts.objectType.name,
                primaryKey,
                property: property.name,
            },
        });
    }

    return opts.object;
}
