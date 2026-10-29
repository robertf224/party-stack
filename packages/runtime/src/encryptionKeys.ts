import {
    EncryptionError,
    type EncryptionKey,
    type EncryptionKeyringService,
} from "@party-stack/ontology-storage/encrypted";
import { Effect, Exit, Result } from "effect";
import * as Base64 from "effect/encoding/Base64";
import type { RuntimeError } from "./Runtime.js";

/** Platform key-material persistence used underneath the encryption keyring. */
export interface KeyMaterialStore {
    readonly get: (id: string) => Effect.Effect<string | undefined, RuntimeError>;
    readonly set: (id: string, value: string) => Effect.Effect<void, RuntimeError>;
    readonly delete: (id: string) => Effect.Effect<void, RuntimeError>;
}

export interface KeyMaterialCodec {
    readonly generate: () => Promise<string>;
    readonly import: (encoded: string) => Promise<EncryptionKey>;
}
const webCryptoKeys: KeyMaterialCodec = {
    generate: async () => Base64.encode(crypto.getRandomValues(new Uint8Array(32))),
    import: async (encoded) => {
        const decoded = Base64.decode(encoded);
        if (Result.isFailure(decoded)) throw new Error("Invalid encryption key.");
        return crypto.subtle.importKey("raw", new Uint8Array(decoded.success), "AES-GCM", false, [
            "encrypt",
            "decrypt",
        ]);
    },
};
/** Keys and the active key ID stay in the platform secret store. Unique immutable
 * key slots make concurrent first creation safe without a database lock or CAS:
 * both creators retain their keys, whichever active ID is published last wins.
 * Never hold a database transaction open while waiting for the OS keychain.
 */
export const makeKeyMaterialStoreKeyring = Effect.fnUntraced(function* (
    secrets: KeyMaterialStore,
    codec: KeyMaterialCodec = webCryptoKeys
) {
    const failure = () =>
        new EncryptionError({
            operation: "key",
            kind: "Crypto",
            message: "Platform encryption key access failed.",
        });
    const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
    const slot = (id: string) => `encryption:key:${id}`;
    const get = (id: string) =>
        Effect.gen(function* () {
            const encoded = yield* secrets.get(slot(id));
            return encoded === undefined ? undefined : yield* attempt(() => codec.import(encoded));
        }).pipe(Effect.mapError(failure));
    const active = yield* Effect.cachedWithTTL(
        Effect.gen(function* () {
            const existing = yield* secrets.get("encryption:active");
            if (existing) {
                const key = yield* get(existing);
                if (!key) return yield* failure();
                return { id: existing, key };
            }
            const id = crypto.randomUUID();
            const encoded = yield* attempt(codec.generate);
            const key = yield* attempt(() => codec.import(encoded));
            yield* Effect.uninterruptible(
                Effect.gen(function* () {
                    yield* secrets.set(slot(id), encoded);
                    yield* secrets.set("encryption:active", id);
                })
            );
            return { id, key };
        }).pipe(Effect.mapError(failure)),
        (exit) => (Exit.isSuccess(exit) ? Infinity : 0)
    );
    return { active, get } satisfies EncryptionKeyringService;
});

/** Ephemeral keys for isolated memory runtimes; no key material is persisted. */
export const makeMemoryEncryptionKeyring = Effect.fnUntraced(function* () {
    const id = crypto.randomUUID();
    const key = yield* Effect.cached(
        Effect.tryPromise({
            try: () =>
                crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
            catch: () =>
                new EncryptionError({
                    operation: "key",
                    kind: "Crypto",
                    message: "Could not create an ephemeral encryption key.",
                }),
        })
    );
    return {
        active: Effect.map(key, (key) => ({ id, key })),
        get: (requested: string) => (requested === id ? key : Effect.succeed(undefined)),
    } satisfies EncryptionKeyringService;
});
