import { BackendError, encryptedPropertyCodec, EncryptedValueSchema } from "@party-stack/ontology-backend";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";
import type { ReplicaService } from "./engine.js";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";
import type { EncryptionKeyringService } from "@party-stack/ontology-storage/encrypted";

const rejected = (message: string, kind: BackendError["kind"] = "InvalidRequest") =>
    new BackendError({ operation: "replica.decrypt", kind, message, retryable: false });
// Do not retain decoder issues, provider exceptions or inputs: all can contain secrets.
const safe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
        Effect.mapError((error) =>
            error instanceof BackendError
                ? new BackendError({
                      operation: "replica.decrypt",
                      kind: error.kind,
                      retryable: error.retryable,
                      message: "Decryption failed.",
                  })
                : rejected("Encrypted value storage is unavailable.", "Unavailable")
        )
    );

/** One cache per already authenticated Runtime partition, further separated by authority and property.
 * Ciphertexts are device-encrypted copies, never imported provider ciphertext.
 */
export const makeReplicaDecryption = (options: {
    readonly ir: OntologyIR;
    readonly cache: ReplicaService["encryptedCache"];
    readonly namespace: string;
    readonly keyring?: EncryptionKeyringService;
    readonly backend: Pick<OntologyBackendService, "sourceId" | "encrypted">;
}) => {
    const { backend, ir } = options;
    const namespace = JSON.stringify(["decrypted-cache", options.namespace]);
    const CachedPlaintext = Schema.Struct({ binding: Schema.String, value: Schema.Unknown });
    const parse = (value: Encrypted) =>
        Effect.try({
            try: () => {
                const handle = Schema.decodeUnknownSync(EncryptedValueSchema)(value);
                const codec = encryptedPropertyCodec(ir, handle);
                const key = JSON.stringify([backend.sourceId, handle.source]);
                return { handle, codec, key };
            },
            catch: () => rejected("Decryption requires a known top-level encrypted property source."),
        });
    const values = () => makeEncryptedValues(namespace, options.keyring!);
    const decrypt = Effect.fn("Replica.decrypt")(function* (
        value: Encrypted,
        settings?: { cache?: boolean }
    ) {
        const { handle, codec, key } = yield* parse(value);
        if (settings?.cache && !options.keyring)
            return yield* rejected(
                "Caching decrypted values requires an explicitly configured encryption keyring.",
                "NotImplemented"
            );
        if (settings?.cache) {
            const local = yield* safe(options.cache.get(handle));
            if (local) {
                const result = yield* Effect.result(
                    safe(values().decrypt(CachedPlaintext, local)).pipe(
                        Effect.flatMap((cached) =>
                            Effect.try({
                                try: () => {
                                    const envelope = Schema.decodeUnknownSync(CachedPlaintext)(cached);
                                    if (envelope.binding !== JSON.stringify([key, handle.ciphertext]))
                                        throw new Error();
                                    return codec.decode(envelope.value);
                                },
                                catch: () => rejected("Invalid cached value binding."),
                            })
                        )
                    )
                );
                if (result._tag === "Success")
                    return { value: result.success, ciphertext: handle.ciphertext };
                // Lost keys or corrupt ciphertext must not permanently prevent an authorized refetch.
            }
        }
        if (!backend.encrypted)
            return yield* rejected("The source does not support decryption.", "NotImplemented");
        const result = yield* safe(backend.encrypted.decrypt(handle));
        const decoded = yield* Effect.try({
            try: () => codec.decode(result.value),
            catch: () => rejected("Invalid decrypted plaintext.", "InvalidResponse"),
        });
        if (result.ciphertext !== undefined && result.ciphertext !== handle.ciphertext)
            return yield* rejected("The encrypted value changed; reload it before decrypting.", "Conflict");
        // No identity evidence means the caller may use this current-property response, but we cannot cache it.
        if (settings?.cache && result.ciphertext === handle.ciphertext) {
            const local = yield* safe(
                values().encrypt(CachedPlaintext, {
                    binding: JSON.stringify([key, handle.ciphertext]),
                    value: result.value,
                })
            );
            yield* safe(options.cache.put(handle, local));
        }
        return { value: decoded, ciphertext: result.ciphertext };
    });
    return { decrypt };
};
