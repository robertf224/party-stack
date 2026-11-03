import { compileEffectSchemas } from "@party-stack/ontology-spec/effect";
import { decode, encode } from "@party-stack/ontology-spec/json";
import { resolveType } from "@party-stack/ontology-spec/utils";
import { Effect, Schema } from "effect";
import { BackendError } from "./errors.js";
import type { BackendEncryptedValues } from "./index.js";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";
import type { Key } from "@party-stack/ontology-storage";

export const EncryptedValueSchema = Schema.Struct({
    ciphertext: Schema.NonEmptyString,
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
    /** Ciphertext associated with this plaintext. Contradictions are rejected; absent binding prevents caching.
     * Prefer an authority-proven value. Adapters using current-property APIs must explicitly document any assumption.
     */
    ciphertext: Schema.optional(Schema.NonEmptyString),
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

/** Authoritative property decryption, shared by owned storage and credential authorities.
 * Server projection supplies caller authorization; this binds decryption to the
 * current row/property and validates its plaintext contract.
 */
export function makePropertyDecryption(options: {
    readonly ir: OntologyIR;
    readonly get: (
        objectType: string,
        key: Key
    ) => Effect.Effect<Record<string, unknown> | undefined, BackendError>;
    readonly decrypt: (handle: Encrypted) => Effect.Effect<unknown, BackendError>;
}): BackendEncryptedValues {
    return {
        decrypt: Effect.fn("Backend.decrypt")(function* (value) {
            const checked = yield* Effect.try({
                try: () => {
                    const handle = Schema.decodeUnknownSync(EncryptedValueSchema)(value);
                    return { handle, codec: encryptedPropertyCodec(options.ir, handle) };
                },
                catch: () =>
                    new BackendError({
                        operation: "decrypt",
                        kind: "InvalidRequest",
                        retryable: false,
                        message: "Invalid encrypted property handle.",
                    }),
            });
            const source = checked.handle.source!;
            const current = (yield* options.get(source.objectType, source.primaryKey))?.[source.property];
            if (
                !current ||
                typeof current !== "object" ||
                !("ciphertext" in current) ||
                current.ciphertext !== checked.handle.ciphertext
            )
                return yield* new BackendError({
                    operation: "decrypt",
                    kind: "Conflict",
                    retryable: false,
                    message: "The encrypted property changed or is unavailable.",
                });
            const plaintext = yield* options.decrypt(checked.handle);
            return yield* Effect.try({
                try: () => {
                    checked.codec.decode(plaintext);
                    return { value: plaintext, ciphertext: checked.handle.ciphertext };
                },
                catch: () =>
                    new BackendError({
                        operation: "decrypt",
                        kind: "Internal",
                        retryable: false,
                        message: "Invalid decrypted plaintext.",
                    }),
            });
        }),
    };
}
