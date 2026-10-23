import { EncryptedValueSchema } from "@party-stack/ontology-backend";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { Schema } from "effect";
import type { OntologyIR, ObjectTypeDef } from "@party-stack/ontology-spec";

/** Native handles carry no plaintext type; their containing property supplies it at the live boundary. */
export function decorateObjectEncryptedSources(
    ir: OntologyIR,
    objectType: ObjectTypeDef,
    row: Record<string, unknown>
) {
    const primaryKey = row[objectType.primaryKey];
    if (typeof primaryKey !== "string" && typeof primaryKey !== "number") return row;
    for (const property of objectType.properties) {
        let type = resolveType(ir, property.type);
        while (type.kind === "optional") type = resolveType(ir, type.value.type);
        if (type.kind !== "encrypted" || row[property.name] === undefined) continue;
        const handle = Schema.decodeUnknownSync(EncryptedValueSchema)(row[property.name]);
        row[property.name] = {
            ...handle,
            source: { objectType: objectType.name, primaryKey, property: property.name },
        };
    }
    return row;
}
