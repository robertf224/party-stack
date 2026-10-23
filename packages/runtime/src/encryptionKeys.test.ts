import { makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { makeSecretStoreKeyring } from "./encryptionKeys.js";
import type { SecretStore } from "./types.js";

const memory = (entries = new Map<string, string>()): SecretStore => ({
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
    const keys = await Effect.runPromise(makeSecretStoreKeyring(memory(entries)));
    expect(entries.size).toBe(0);
    const encrypted = await Effect.runPromise(
        makeEncryptedValues("user", keys).encrypt(Schema.String, "secret")
    );
    expect(entries.size).toBe(2);
    const reopened = await Effect.runPromise(makeSecretStoreKeyring(memory(entries)));
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
        Effect.all([makeSecretStoreKeyring(racing), makeSecretStoreKeyring(racing)])
    );
    const encrypted = await Effect.runPromise(
        Effect.all(
            [first, second].map((keys) => makeEncryptedValues("user", keys).encrypt(Schema.String, "value")),
            { concurrency: "unbounded" }
        )
    );
    const reopened = await Effect.runPromise(makeSecretStoreKeyring(secrets));
    for (const value of encrypted)
        expect(
            await Effect.runPromise(makeEncryptedValues("user", reopened).decrypt(Schema.String, value))
        ).toBe("value");
});
test("an active ID whose key is missing fails without creating a replacement", async () => {
    const entries = new Map([["encryption:active", "lost-key"]]);
    const keys = await Effect.runPromise(makeSecretStoreKeyring(memory(entries)));
    await expect(Effect.runPromise(keys.active)).rejects.toMatchObject({ _tag: "EncryptionError" });
    expect(entries.size).toBe(1);
});
