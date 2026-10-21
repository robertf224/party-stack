import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { Effect, Exit, Scope } from "effect";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { expect, test } from "vitest";
import { makeEncryptionKeyring } from "./encryptionKeyring.js";

test("concurrent keyring openings choose one durable nonextractable key and survive reopening", async () => {
    const factory = new IDBFactory();
    const acquire = (scope: Scope.Scope) =>
        Effect.runPromise(
            makeEncryptionKeyring("test-keys").pipe(
                Effect.provideService(
                    IndexedDb.IndexedDb,
                    IndexedDb.make({ indexedDB: factory, IDBKeyRange })
                ),
                (effect) => Scope.provide(effect, scope)
            )
        );
    const first = Effect.runSync(Scope.make());
    const [a, b] = await Promise.all([acquire(first), acquire(first)]);
    const [left, right] = await Promise.all([Effect.runPromise(a.active), Effect.runPromise(b.active)]);
    expect(left.id).toBe(right.id);
    expect(left.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", left.key)).rejects.toThrow(/extractable/i);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        left.key,
        new TextEncoder().encode("secret-test-value")
    );
    await Effect.runPromise(Scope.close(first, Exit.void));
    const second = Effect.runSync(Scope.make());
    try {
        const reopened = await acquire(second);
        expect((await Effect.runPromise(reopened.active)).id).toBe(left.id);
        const key = await Effect.runPromise(reopened.get(left.id));
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key!, encrypted);
        expect(new TextDecoder().decode(decrypted)).toBe("secret-test-value");
        expect(await Effect.runPromise(reopened.get("missing"))).toBeUndefined();
    } finally {
        await Effect.runPromise(Scope.close(second, Exit.void));
    }
});
