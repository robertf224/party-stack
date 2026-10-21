import { collectAttachments } from "@party-stack/ontology-storage/blobs";
import type { ObjectTypeDef, OntologyIR } from "@party-stack/ontology-spec";

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
        for (const entry of collectAttachments(opts.ir, property.type, opts.object[property.name])) {
            entry.attachment.source = {
                objectType: opts.objectType.name,
                primaryKey,
                property: property.name,
            };
        }
    }

    return opts.object;
}
