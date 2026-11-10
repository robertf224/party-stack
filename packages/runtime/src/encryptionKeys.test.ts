import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { makeKeyMaterialStoreKeyring, makeMemoryEncryptionKeyring } from "./encryptionKeys.js";
import type { KeyMaterialStore } from "./encryptionKeys.js";

const memory = (entries = new Map<string, string>()): KeyMaterialStore => ({
    get: (id) => Effect.sync(() => entries.get(id)),
    set: (id, value) =>
        Effect.sync(() => {
            entries.set(id, value);
        }),
    delete: (id) =>
        Effect.sync(() => {
            entries.delete(id);
        }),
});
test("native key acquisition is lazy, persists outside tables, and decrypts after reopening", async () => {
    const entries = new Map<string, string>();
    const keys = await Effect.runPromise(makeKeyMaterialStoreKeyring(memory(entries)));
    expect(entries.size).toBe(0);
    const encrypted = await Effect.runPromise(
        makeEncryptedValues("user", keys).encrypt(Schema.String, "secret")
    );
    expect(entries.size).toBe(2);
    const reopened = await Effect.runPromise(makeKeyMaterialStoreKeyring(memory(entries)));
    expect(
        await Effect.runPromise(makeEncryptedValues("user", reopened).decrypt(Schema.String, encrypted))
    ).toBe("secret");
    expect(JSON.stringify([...entries])).not.toContain("secret");
    expect(await Effect.runPromise(reopened.get("missing"))).toBeUndefined();
    expect(entries.size).toBe(2);
});
test("concurrent first creation never overwrites another creator's immutable key", async () => {
    const entries = new Map<string, string>();
    const secrets = memory(entries);
    const racing = {
        ...secrets,
        get: (id: string) =>
            Effect.gen(function* () {
                const value = yield* secrets.get(id);
                yield* Effect.yieldNow;
                return value;
            }),
    };
    const [first, second] = await Effect.runPromise(
        Effect.all([makeKeyMaterialStoreKeyring(racing), makeKeyMaterialStoreKeyring(racing)])
    );
    const encrypted = await Effect.runPromise(
        Effect.all(
            [first, second].map((keys) => makeEncryptedValues("user", keys).encrypt(Schema.String, "value")),
            { concurrency: "unbounded" }
        )
    );
    const reopened = await Effect.runPromise(makeKeyMaterialStoreKeyring(secrets));
    for (const value of encrypted)
        expect(
            await Effect.runPromise(makeEncryptedValues("user", reopened).decrypt(Schema.String, value))
        ).toBe("value");
});
test("an active ID whose key is missing fails without creating a replacement", async () => {
    const entries = new Map([["encryption:active", "lost-key"]]);
    const keys = await Effect.runPromise(makeKeyMaterialStoreKeyring(memory(entries)));
    await expect(Effect.runPromise(keys.active)).rejects.toMatchObject({ _tag: "EncryptionError" });
    expect(entries.size).toBe(1);
});

test("memory keyrings are stable within an instance and cannot decrypt another instance's ciphertext", async () => {
    const keys = await Effect.runPromise(makeMemoryEncryptionKeyring());
    const first = await Effect.runPromise(keys.active);
    expect((await Effect.runPromise(keys.active)).id).toBe(first.id);
    const encrypted = await Effect.runPromise(
        makeEncryptedValues("memory", keys).encrypt(Schema.String, "token")
    );
    expect(
        await Effect.runPromise(makeEncryptedValues("memory", keys).decrypt(Schema.String, encrypted))
    ).toBe("token");
    const reopened = await Effect.runPromise(makeMemoryEncryptionKeyring());
    await expect(
        Effect.runPromise(makeEncryptedValues("memory", reopened).decrypt(Schema.String, encrypted))
    ).rejects.toMatchObject({ kind: "MissingKey" });
});
