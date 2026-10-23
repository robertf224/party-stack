import { Context, Effect, Layer, Result, Schema } from "effect";
import * as Base64 from "effect/encoding/Base64";
import type { Encrypted } from "@party-stack/ontology-spec/values";

export class EncryptionError extends Schema.TaggedError<EncryptionError>()("EncryptionError", {
    operation: Schema.Literals(["encrypt", "decrypt", "key"]),
    kind: Schema.Literals(["MissingKey", "InvalidValue", "InvalidCiphertext", "Crypto"]),
    message: Schema.String,
}) {}

/** Key material stays in a platform key service, outside ordinary table data. */
export interface EncryptionKeyringService {
    readonly active: Effect.Effect<{ readonly id: string; readonly key: CryptoKey }, EncryptionError>;
    readonly get: (id: string) => Effect.Effect<CryptoKey | undefined, EncryptionError>;
}
export class EncryptionKeyring extends Context.Service<EncryptionKeyring, EncryptionKeyringService>()(
    "@party-stack/ontology-storage/EncryptionKeyring"
) {}

const prefix = "party-stack:encrypted:v1:";

const CiphertextSchema = Schema.Struct({
    format: Schema.Literal("aes-gcm-v1"),
    keyId: Schema.String,
    iv: Schema.String,
    data: Schema.String,
});
type Ciphertext = typeof CiphertextSchema.Type;
type Failure = EncryptionError;
export interface EncryptedValuesService {
    readonly encrypt: <A, AI>(schema: Schema.Codec<A, AI>, value: A) => Effect.Effect<Encrypted<A>, Failure>;
    readonly decrypt: <A, AI>(schema: Schema.Codec<A, AI>, value: Encrypted<A>) => Effect.Effect<A, Failure>;
}
export class EncryptedValues extends Context.Service<EncryptedValues, EncryptedValuesService>()(
    "@party-stack/ontology-storage/EncryptedValues"
) {
    static readonly layer = (namespace: string) => Layer.effect(EncryptedValues, make(namespace));
}
const failure = (operation: EncryptionError["operation"], kind: EncryptionError["kind"], message: string) =>
    new EncryptionError({ operation, kind, message });

/** Local owned encryption provider. Remote providers can implement a decrypt hook instead. */
export const make = Effect.fnUntraced(function* (namespace: string) {
    const keys = yield* EncryptionKeyring;
    return makeEncryptedValues(namespace, keys);
});

export function makeEncryptedValues(
    namespace: string,
    keys: EncryptionKeyringService
): EncryptedValuesService {
    const bytes = (encoded: string) => {
        const result = Base64.decode(encoded);
        return Result.isSuccess(result)
            ? Effect.succeed(new Uint8Array(result.success))
            : Effect.fail(failure("decrypt", "InvalidCiphertext", "Invalid ciphertext encoding."));
    };
    const aad = (keyId: string) =>
        new TextEncoder().encode(JSON.stringify(["party-stack/encrypted/v1", namespace, keyId]));
    return {
        encrypt: Effect.fnUntraced(function* <A, AI>(schema: Schema.Codec<A, AI>, value: A) {
            const json = Schema.fromJsonString(Schema.toCodecJson(schema));
            const text = yield* Schema.encodeEffect(json)(value).pipe(
                Effect.mapError(() =>
                    failure("encrypt", "InvalidValue", "Value does not match its plaintext schema.")
                )
            );
            const key = yield* keys.active;
            return yield* Effect.tryPromise({
                try: async () => {
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const data = await crypto.subtle.encrypt(
                        { name: "AES-GCM", iv, additionalData: aad(key.id), tagLength: 128 },
                        key.key,
                        new TextEncoder().encode(text)
                    );
                    const envelope: Ciphertext = {
                        format: "aes-gcm-v1",
                        keyId: key.id,
                        iv: Base64.encode(iv),
                        data: Base64.encode(new Uint8Array(data)),
                    };
                    return { ciphertext: prefix + JSON.stringify(envelope) } as Encrypted<A>;
                },
                catch: () => failure("encrypt", "Crypto", "Could not encrypt value."),
            });
        }),
        decrypt: Effect.fnUntraced(function* <A, AI>(schema: Schema.Codec<A, AI>, value: Encrypted<A>) {
            const encrypted = yield* Effect.try({
                try: () => {
                    if (!value.ciphertext.startsWith(prefix)) throw new Error();
                    return Schema.decodeUnknownSync(CiphertextSchema)(
                        JSON.parse(value.ciphertext.slice(prefix.length))
                    );
                },
                catch: () => failure("decrypt", "InvalidCiphertext", "Invalid native ciphertext."),
            });
            const key = yield* keys.get(encrypted.keyId);
            if (!key) return yield* failure("key", "MissingKey", "The decryption key is not available.");
            const iv = yield* bytes(encrypted.iv);
            const data = yield* bytes(encrypted.data);
            const text = yield* Effect.tryPromise({
                try: async () => {
                    const plaintext = await crypto.subtle.decrypt(
                        {
                            name: "AES-GCM",
                            iv,
                            additionalData: aad(encrypted.keyId),
                            tagLength: 128,
                        },
                        key,
                        data
                    );
                    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
                },
                catch: () =>
                    failure(
                        "decrypt",
                        "InvalidCiphertext",
                        "Ciphertext authentication or decryption failed."
                    ),
            });
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
                text
            ).pipe(
                Effect.mapError(() =>
                    failure("decrypt", "InvalidValue", "Decrypted value does not match its plaintext schema.")
                )
            );
        }),
    };
}
