import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";
import { connectError } from "../core/errors.js";
import type { RuntimeService } from "@party-stack/runtime";

/** Native runtimes encrypt and update handles in the same Tables transaction.
 * A supplied platform SecretStore is a separate, platform-owned security boundary.
 */
export function runtimeCredentialValues(
    runtime: RuntimeService,
    namespace: string,
    allowPlaintext = false
): Effect.Effect<
    import("../core/Connect.js").ConnectCredentialValues,
    import("../core/errors.js").ConnectError
> {
    if (runtime.encryptionKeyring)
        return Effect.succeed(makeEncryptedValues(namespace, runtime.tables, runtime.encryptionKeyring));
    const platform = runtime.adapter.secrets;
    if (!platform && !allowPlaintext)
        return Effect.fail(
            connectError(
                "Configuration",
                "OAuth requires RuntimeAdapter.secrets or an encryption key service. Set dangerouslyPersistSecrets to explicitly allow ordinary credential persistence."
            )
        );
    const plain = Table.make<{ value: string }>({
        name: JSON.stringify(["connect", namespace, "explicit-plaintext-secrets"]),
    });
    const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
            try: run,
            catch: () => connectError("Storage", "Platform credential operation failed.", true),
        });
    const get = (id: string) =>
        platform
            ? attempt(() => platform.get(id))
            : runtime.tables.get(plain, id).pipe(Effect.map((row) => row?.value));
    const set = (id: string, value: string) =>
        platform ? attempt(() => platform.set(id, value)) : runtime.tables.put(plain, id, { value });
    const drop = (id: string) =>
        platform ? attempt(() => platform.delete(id)) : runtime.tables.delete(plain, id);
    return Effect.succeed({
        encrypt: Effect.fnUntraced(function* <A, AI>(schema: Schema.Codec<A, AI>, value: A) {
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
                value
            ).pipe(Effect.mapError(() => connectError("Storage", "Invalid credential value.")));
            const id = `${namespace}:${crypto.randomUUID()}`;
            yield* set(id, encoded);
            return { id };
        }),
        decrypt: Effect.fnUntraced(function* <A, AI>(
            schema: Schema.Codec<A, AI>,
            value: import("@party-stack/ontology-spec/values").Encrypted<A>
        ) {
            const encoded = yield* get(value.id);
            if (encoded === undefined) return yield* connectError("Storage", "Credential is unavailable.");
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
                encoded
            ).pipe(Effect.mapError(() => connectError("Storage", "Invalid stored credential.")));
        }),
        evict: (value) => drop(value.id),
    });
}
