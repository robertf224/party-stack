import { BackendError, encryptedPropertyCodec, EncryptedValueSchema } from "@party-stack/ontology-backend";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Runtime } from "@party-stack/runtime";
import { Effect, Schema } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { ReplicaService } from "@party-stack/ontology-replica";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";

const rejected = (message: string, kind: BackendError["kind"] = "ValidationFailed") =>
    new BackendError({ operation: "ontology.decrypt", kind, message, retryable: false });
// Do not retain decoder issues, provider exceptions or inputs: all can contain secrets.
const safe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
        Effect.mapError((error) =>
            error instanceof BackendError
                ? new BackendError({
                      operation: "ontology.decrypt",
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
export const makeLiveDecryption = Effect.fnUntraced(function* (options: {
    readonly ir: OntologyIR;
    readonly replica: Pick<ReplicaService, "encryptedCache">;
    readonly backend: Pick<OntologyBackendService, "sourceId" | "encrypted">;
}) {
    const runtime = yield* Runtime;
    const { backend, ir } = options;
    const namespace = JSON.stringify(["decrypted-cache", runtime.adapter.owner, runtime.adapter.namespace]);
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
    const values = () => makeEncryptedValues(namespace, runtime.encryptionKeyring!);
    const decrypt = Effect.fn("Ontology.decrypt")(function* (
        value: Encrypted,
        settings?: { cache?: boolean }
    ) {
        const { handle, codec, key } = yield* parse(value);
        if (settings?.cache && !runtime.encryptionKeyring)
            return yield* rejected(
                "Caching decrypted values requires an explicitly configured encryption keyring.",
                "NotImplemented"
            );
        if (settings?.cache) {
            const local = yield* safe(options.replica.encryptedCache.get(handle));
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
                if (result._tag === "Success") return result.success;
                // Lost keys or corrupt ciphertext must not permanently prevent an authorized refetch.
            }
        }
        if (!backend.encrypted)
            return yield* rejected("The source does not support decryption.", "NotImplemented");
        const result = yield* safe(backend.encrypted.decrypt(handle));
        const decoded = yield* Effect.try({
            try: () => codec.decode(result.value),
            catch: () => rejected("Invalid decrypted plaintext."),
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
            yield* safe(options.replica.encryptedCache.put(handle, local));
        }
        return decoded;
    });
    return { decrypt };
});
