import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { memoryRuntimeFixture, defineRuntimeFixture } from "@party-stack/runtime/testing";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { createEncryptedSecretStore } from "./encryptedSecrets.js";

test("secret replacement atomically replaces embedded ciphertext without persisting plaintext", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    const base = memoryRuntimeFixture("user", "secret-test");
    const runtime = defineRuntimeFixture(() => ({
        ...base,
        tables: Effect.succeed(tables),
        encryptionKeyring: Effect.succeed({
            active: Effect.succeed({ id: "test-key", key }),
            get: (id: string) => Effect.succeed(id === "test-key" ? key : undefined),
        }),
    }))("user", "secret-test");
    const handles = Table.make<{ ciphertext: string }>({
        name: JSON.stringify(["runtime", runtime.owner, runtime.namespace, "secrets"]),
    });
    const secrets = createEncryptedSecretStore(runtime);
    try {
        await Effect.runPromise(secrets.set("refresh", "first-secret-value"));
        const first = await Effect.runPromise(tables.get(handles, "refresh"));
        expect(Object.keys(first!)).toEqual(["ciphertext"]);
        expect(await Effect.runPromise(secrets.get("refresh"))).toBe("first-secret-value");
        await Effect.runPromise(secrets.set("refresh", "second-secret-value"));
        expect((await Effect.runPromise(tables.get(handles, "refresh")))?.ciphertext).not.toBe(
            first?.ciphertext
        );
        expect(await Effect.runPromise(secrets.get("refresh"))).toBe("second-secret-value");
        const persisted = await Effect.runPromise(tables.loadSubset(handles));
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted)).not.toContain("secret-value");
        expect(await Effect.runPromise(createEncryptedSecretStore(runtime).get("refresh"))).toBe(
            "second-secret-value"
        );
        await Effect.runPromise(secrets.delete("refresh"));
        expect(await Effect.runPromise(secrets.get("refresh"))).toBeUndefined();
        expect(await Effect.runPromise(tables.loadSubset(handles))).toEqual([]);
    } finally {
        await runtime.cleanup?.();
    }
    await expect(Effect.runPromise(secrets.get("refresh"))).rejects.toThrow(/disposed|closed|interrupted/i);
});
