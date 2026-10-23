import { BackendError, encryptedPropertyCodec, EncryptedValueSchema } from "@party-stack/ontology-backend";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Table } from "@party-stack/ontology-storage/tables";
import { Runtime } from "@party-stack/runtime";
import { Effect, Schema } from "effect";
import type { OntologyBackendService } from "@party-stack/ontology-backend";
import type { OntologyIR } from "@party-stack/ontology-spec";
import type { Encrypted } from "@party-stack/ontology-spec/values";

const rejected = (message: string, kind: BackendError["kind"] = "Rejected") =>
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
    readonly backend: Pick<OntologyBackendService, "sourceId" | "encrypted">;
}) {
    const runtime = yield* Runtime;
    const { backend, ir } = options;
    const namespace = JSON.stringify(["decrypted-cache", runtime.adapter.owner, runtime.adapter.namespace]);
    const CachedPlaintext = Schema.Struct({ binding: Schema.String, value: Schema.Unknown });
    const CacheEntry = Schema.Struct({ valueId: Schema.NonEmptyString, local: EncryptedValueSchema });
    const cache = Table.make({
        name: namespace,
        codec: {
            encode: Schema.encodeSync(CacheEntry),
            decode: Schema.decodeUnknownSync(CacheEntry),
        },
    });
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
    const values = (tables: Parameters<typeof makeEncryptedValues>[1]) =>
        makeEncryptedValues(namespace, tables, runtime.encryptionKeyring!);
    const evict = Effect.fnUntraced(function* (value: Encrypted) {
        const { handle, key } = yield* parse(value);
        yield* safe(
            runtime.tables.transaction(
                Effect.fnUntraced(function* (tx) {
                    const entry = yield* tx.get(cache, key);
                    if (!entry || entry.valueId !== handle.id) return;
                    yield* tx.delete(cache, key);
                    // Eviction deletes bytes and does not need a usable encryption key.
                    yield* values(tx).evict(entry.local);
                })
            )
        );
    });
    const decrypt = Effect.fn("Ontology.decrypt")(function* (
        value: Encrypted,
        settings?: { cache?: boolean }
    ) {
        const { handle, codec, key } = yield* parse(value);
        if (settings?.cache && !runtime.encryptionKeyring)
            return yield* rejected(
                "Caching decrypted values requires an explicitly configured encryption keyring.",
                "Unsupported"
            );
        if (settings?.cache) {
            const entry = yield* safe(runtime.tables.get(cache, key));
            if (entry?.valueId === handle.id) {
                const result = yield* Effect.result(
                    safe(values(runtime.tables).decrypt(CachedPlaintext, entry.local)).pipe(
                        Effect.flatMap((cached) =>
                            Effect.try({
                                try: () => {
                                    const envelope = Schema.decodeUnknownSync(CachedPlaintext)(cached);
                                    if (envelope.binding !== JSON.stringify([key, handle.id]))
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
                yield* evict(handle);
            }
        }
        if (!backend.encrypted)
            return yield* rejected("The source does not support decryption.", "Unsupported");
        const result = yield* safe(backend.encrypted.decrypt(handle));
        const decoded = yield* Effect.try({
            try: () => codec.decode(result.value),
            catch: () => rejected("Invalid decrypted plaintext."),
        });
        if (result.valueId !== undefined && result.valueId !== handle.id)
            return yield* rejected("The encrypted value changed; reload it before decrypting.", "Conflict");
        // No identity evidence means the caller may use this current-property response, but we cannot cache it.
        if (settings?.cache && result.valueId === handle.id) {
            yield* safe(
                runtime.tables.transaction(
                    Effect.fnUntraced(function* (tx) {
                        const previous = yield* tx.get(cache, key);
                        const local = yield* values(tx).encrypt(CachedPlaintext, {
                            binding: JSON.stringify([key, handle.id]),
                            value: result.value,
                        });
                        yield* tx.put(cache, key, { valueId: handle.id, local });
                        if (previous) yield* values(tx).evict(previous.local);
                    })
                )
            );
        }
        return decoded;
    });
    return { decrypt, evict };
});
