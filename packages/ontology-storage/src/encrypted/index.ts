import { Context, Effect, Layer, Result, Schema } from "effect";
import * as Base64 from "effect/encoding/Base64";
import { Table } from "../model.js";
import { Tables, type TablesService } from "../tables.js";
import type { OntologyStorageError } from "../errors.js";
import type { Encrypted } from "@party-stack/ontology-spec/values";

export class EncryptionError extends Schema.TaggedError<EncryptionError>()("EncryptionError", {
    operation: Schema.Literals(["encrypt", "decrypt", "key", "ciphertext"]),
    kind: Schema.Literals(["MissingCiphertext", "MissingKey", "InvalidValue", "InvalidCiphertext", "Crypto"]),
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

export const CiphertextSchema = Schema.Struct({
    format: Schema.Literal("aes-gcm-v1"),
    keyId: Schema.String,
    iv: Schema.String,
    data: Schema.String,
});
export type Ciphertext = typeof CiphertextSchema.Type;
type Failure = EncryptionError | OntologyStorageError;
export interface EncryptedValuesService {
    readonly encrypt: <A, AI>(schema: Schema.Codec<A, AI>, value: A) => Effect.Effect<Encrypted<A>, Failure>;
    readonly decrypt: <A, AI>(schema: Schema.Codec<A, AI>, value: Encrypted<A>) => Effect.Effect<A, Failure>;
    readonly ciphertext: (value: Encrypted<unknown>) => Effect.Effect<Ciphertext | undefined, Failure>;
    /** Import existing ciphertext from a trusted source. This does not decrypt or re-encrypt it; the original key and namespace are still required. */
    readonly importCiphertext: (
        value: Encrypted<unknown>,
        ciphertext: Ciphertext
    ) => Effect.Effect<void, Failure>;
    /** Local eviction only. Callers must establish that the ciphertext is recoverable. */
    readonly evict: (value: Encrypted<unknown>) => Effect.Effect<void, Failure>;
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
    const tables = yield* Tables;
    const keys = yield* EncryptionKeyring;
    return makeEncryptedValues(namespace, tables, keys);
});

export function makeEncryptedValues(
    namespace: string,
    tables: Pick<TablesService, "get" | "put" | "delete">,
    keys: EncryptionKeyringService
): EncryptedValuesService {
    const ciphertexts = Table.make({
        name: JSON.stringify(["ontology", namespace, "encrypted"]),
        codec: {
            encode: Schema.encodeSync(CiphertextSchema),
            decode: Schema.decodeUnknownSync(CiphertextSchema),
        },
    });
    const bytes = (encoded: string) => {
        const result = Base64.decode(encoded);
        return Result.isSuccess(result)
            ? Effect.succeed(new Uint8Array(result.success))
            : Effect.fail(failure("decrypt", "InvalidCiphertext", "Invalid ciphertext encoding."));
    };
    const aad = (id: string, keyId: string) =>
        new TextEncoder().encode(JSON.stringify(["party-stack/encrypted/v1", namespace, id, keyId]));
    return {
        encrypt: Effect.fnUntraced(function* <A, AI>(schema: Schema.Codec<A, AI>, value: A) {
            const json = Schema.fromJsonString(Schema.toCodecJson(schema));
            const text = yield* Schema.encodeEffect(json)(value).pipe(
                Effect.mapError(() =>
                    failure("encrypt", "InvalidValue", "Value does not match its plaintext schema.")
                )
            );
            const key = yield* keys.active;
            const prepared = yield* Effect.tryPromise({
                try: async () => {
                    const id = crypto.randomUUID();
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const data = await crypto.subtle.encrypt(
                        { name: "AES-GCM", iv, additionalData: aad(id, key.id), tagLength: 128 },
                        key.key,
                        new TextEncoder().encode(text)
                    );
                    return {
                        value: { id } as Encrypted<A>,
                        ciphertext: {
                            format: "aes-gcm-v1" as const,
                            keyId: key.id,
                            iv: Base64.encode(iv),
                            data: Base64.encode(new Uint8Array(data)),
                        },
                    };
                },
                catch: () => failure("encrypt", "Crypto", "Could not encrypt value."),
            });
            yield* tables.put(ciphertexts, prepared.value.id, prepared.ciphertext);
            return prepared.value;
        }),
        decrypt: Effect.fnUntraced(function* <A, AI>(schema: Schema.Codec<A, AI>, value: Encrypted<A>) {
            const encrypted = yield* tables.get(ciphertexts, value.id);
            if (!encrypted)
                return yield* failure("decrypt", "MissingCiphertext", "Ciphertext is not available locally.");
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
                            additionalData: aad(value.id, encrypted.keyId),
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
        ciphertext: (value) => tables.get(ciphertexts, value.id),
        importCiphertext: (value, ciphertext) => tables.put(ciphertexts, value.id, ciphertext),
        evict: (value) => tables.delete(ciphertexts, value.id),
    };
}
