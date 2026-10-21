import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect, Exit, Schema, Scope } from "effect";
import { expect, test } from "vitest";
import { makeEncryptionKeyring } from "./encryptionKeyring.js";
import { make } from "./tables.js";

test("native IndexedDB commits encrypted handles and ciphertext and restores the nonextractable key", async () => {
    const name = `party-stack-encryption-test:${crypto.randomUUID()}`;
    const handles = Table.make<{ id: string }>({ name: "handles" });
    const acquire = (scope: Scope.Scope) =>
        Effect.runPromise(
            Effect.gen(function* () {
                const tables = yield* make({ databaseName: name });
                const keys = yield* makeEncryptionKeyring(`${name}:keys`);
                return { tables, keys };
            }).pipe(Effect.provide(IndexedDb.layerWindow), (effect) => Scope.provide(effect, scope))
        );
    const first = Effect.runSync(Scope.make());
    const a = await acquire(first);
    await Effect.runPromise(
        a.tables.transaction((tx) =>
            Effect.gen(function* () {
                const values = makeEncryptedValues(name, tx, a.keys);
                yield* tx.put(
                    handles,
                    "refresh",
                    yield* values.encrypt(Schema.String, "browser-secret-fixture")
                );
            })
        )
    );
    const active = await Effect.runPromise(a.keys.active);
    expect(active.key.extractable).toBe(false);
    await Effect.runPromise(Scope.close(first, Exit.void));
    const second = Effect.runSync(Scope.make());
    try {
        const b = await acquire(second);
        expect((await Effect.runPromise(b.keys.active)).id).toBe(active.id);
        const value = await Effect.runPromise(
            b.tables.transaction((tx) =>
                Effect.gen(function* () {
                    const handle = yield* tx.get(handles, "refresh");
                    return yield* makeEncryptedValues(name, tx, b.keys).decrypt(Schema.String, handle!);
                })
            )
        );
        expect(value).toBe("browser-secret-fixture");
    } finally {
        await Effect.runPromise(Scope.close(second, Exit.void));
        await Promise.all(
            [name, `${name}:keys`].map(
                (database) =>
                    new Promise<void>((resolve, reject) => {
                        const request = indexedDB.deleteDatabase(database);
                        request.onsuccess = () => resolve();
                        request.onerror = () => reject(request.error);
                    })
            )
        );
    }
});
