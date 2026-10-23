import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { decode, encode } from "@party-stack/ontology-spec/json";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { Schema } from "effect";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";

export const EncryptedValueSchema = Schema.Struct({
    id: Schema.NonEmptyString,
    source: Schema.optional(
        Schema.Struct({
            objectType: Schema.NonEmptyString,
            primaryKey: Schema.Union([Schema.String, Schema.Finite]),
            property: Schema.NonEmptyString,
        })
    ),
});

/** value uses the property's portable JSON representation, including Temporal and Result values. */
export const DecryptedValueSchema = Schema.Struct({
    value: Schema.Unknown,
    /** Set only when the authority can prove which immutable encrypted value it decrypted.
     * Property-current-value endpoints must omit this when they cannot bind their response.
     */
    valueId: Schema.optional(Schema.NonEmptyString),
});
export type DecryptedValue = typeof DecryptedValueSchema.Type;

/** Resolve and validate a top-level encrypted property without trusting a caller-supplied plaintext type. */
export function encryptedPropertyCodec(ir: OntologyIR, handle: Encrypted) {
    const source = handle.source;
    const property = ir.objectTypes
        .find((object) => object.name === source?.objectType)
        ?.properties.find((property) => property.name === source?.property);
    if (!property) throw new TypeError("Decryption requires a known encrypted property source.");
    let type = resolveType(ir, property.type);
    while (type.kind === "optional") type = resolveType(ir, type.value.type);
    if (type.kind !== "encrypted") throw new TypeError("The property is not encrypted.");
    const plaintext = type.value.type;
    const schemaIr = {
        ...ir,
        queryFunctionTypes: [
            {
                name: "plaintext",
                displayName: "Plaintext",
                parameters: [],
                returnType: plaintext,
            },
        ],
    };
    const schema = Schema.toEncoded(
        Schema.toCodecJson(compileEffectSchemas(schemaIr).queryReturnSchemas.plaintext!)
    );
    const validate = Schema.decodeUnknownSync(schema);
    const target = { kind: "queryFunctionReturn" as const, queryFunctionType: "plaintext" };
    return {
        type: plaintext,
        encode: (value: unknown) => validate(encode({ ir: schemaIr, target, value })),
        decode: (value: unknown) => decode({ ir: schemaIr, target, value: validate(value) }),
    };
}
