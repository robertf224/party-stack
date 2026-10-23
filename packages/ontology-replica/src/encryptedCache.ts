import { Schema } from "effect";
import type { Encrypted } from "@party-stack/ontology-spec/values";
import type { ValueCodec } from "@party-stack/ontology-storage/tables";

// Non-enumerable metadata never follows row spreads, JSON, portable schemas or RPC.
const localCopy = Symbol("replica.encryptedCache");
type Cached = Encrypted & { readonly [localCopy]?: Encrypted };
const Local = Schema.Struct({ ciphertext: Schema.NonEmptyString });
export const cachedCopy = (value: Encrypted): Encrypted | undefined => (value as Cached)[localCopy];
export const withCachedCopy = (value: Encrypted, local: Encrypted): Encrypted =>
    Object.defineProperty({ ...value }, localCopy, { value: local });

/** Persist the device copy inside its encrypted property, while the public schema stays portable. */
export function encryptedCacheCodec(
    codec: ValueCodec<Record<string, unknown>>,
    properties: readonly string[]
): ValueCodec<Record<string, unknown>> {
    return {
        encode: (row) => {
            const encoded = codec.encode(row) as Record<string, unknown>;
            for (const name of properties) {
                const value = row[name] as Cached | undefined;
                if (value && cachedCopy(value))
                    encoded[name] = { ...(encoded[name] as Encrypted), localCache: cachedCopy(value) };
            }
            return encoded;
        },
        decode: (encoded) => {
            const row = codec.decode(encoded);
            for (const name of properties) {
                const stored = (encoded as Record<string, { localCache?: unknown } | undefined>)[name];
                const local = Schema.decodeUnknownOption(Local)(stored?.localCache);
                if (row[name] && local._tag === "Some")
                    row[name] = withCachedCopy(row[name] as Encrypted, local.value);
            }
            return row;
        },
    };
}

export function preserveCachedCopies(
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown>,
    properties: readonly string[]
): Record<string, unknown> {
    const result = { ...next };
    for (const name of properties) {
        const before = previous?.[name] as Encrypted | undefined;
        const after = next[name] as Encrypted | undefined;
        const local = before && cachedCopy(before);
        if (local && after?.ciphertext === before?.ciphertext) result[name] = withCachedCopy(after!, local);
    }
    return result;
}
