import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Fiber, Schema } from "effect";
import { Runtime, runtimeEffects } from "./Runtime.js";
import type { RuntimeAdapter, SecretStore } from "./types.js";

/** Application boundary: only embedded ciphertext enters ordinary storage. */
export function createEncryptedSecretStore(adapter: RuntimeAdapter): SecretStore {
    const managed = runtimeEffects(adapter).runtime;
    const namespace = JSON.stringify([adapter.owner, adapter.namespace]);
    const schema = Schema.Struct({ ciphertext: Schema.String });
    const handles = Table.make({
        name: JSON.stringify(["runtime", adapter.owner, adapter.namespace, "secrets"]),
        codec: { encode: Schema.encodeSync(schema), decode: Schema.decodeUnknownSync(schema) },
    });
    const operation = <A>(
        run: (
            tx: import("@party-stack/ontology-storage/tables").Transaction,
            values: ReturnType<typeof makeEncryptedValues>
        ) => Effect.Effect<A, unknown>
    ) =>
        managed.runPromise(
            Effect.gen(function* () {
                const runtime = yield* Runtime;
                if (!runtime.encryptionKeyring)
                    return yield* Effect.fail(new Error("Runtime encryption is unavailable."));
                const keys = runtime.encryptionKeyring;
                return yield* Effect.flatMap(
                    Effect.forkIn(
                        runtime.tables.transaction((tx) => run(tx, makeEncryptedValues(namespace, keys))),
                        runtime.scope
                    ),
                    Fiber.join
                );
            })
        );
    return {
        get: (key) =>
            operation((tx, values) =>
                Effect.gen(function* () {
                    const handle = yield* tx.get(handles, key);
                    return handle ? yield* values.decrypt(Schema.String, handle) : undefined;
                })
            ),
        set: (key, value) =>
            operation((tx, values) =>
                Effect.gen(function* () {
                    const next = yield* values.encrypt(Schema.String, value);
                    yield* tx.put(handles, key, next);
                })
            ),
        delete: (key) =>
            operation((tx, values) =>
                Effect.gen(function* () {
                    yield* tx.delete(handles, key);
                })
            ),
    };
}
