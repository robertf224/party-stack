import * as Memory from "@party-stack/ontology-storage/memory/tables";
import { Table } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { createEncryptedSecretStore } from "./encryptedSecrets.js";
import { createDefaultRuntime } from "./utils/createDefaultRuntime.js";
import { defineRuntime } from "./utils/defineRuntime.js";

test("secret replacement atomically replaces embedded ciphertext without persisting plaintext", async () => {
    const tables = await Effect.runPromise(Memory.make());
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    const base = createDefaultRuntime("user", "secret-test");
    const runtime = defineRuntime(() => ({
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
        await secrets.set("refresh", "first-secret-value");
        const first = await Effect.runPromise(tables.get(handles, "refresh"));
        expect(Object.keys(first!)).toEqual(["ciphertext"]);
        expect(await secrets.get("refresh")).toBe("first-secret-value");
        await secrets.set("refresh", "second-secret-value");
        expect((await Effect.runPromise(tables.get(handles, "refresh")))?.ciphertext).not.toBe(
            first?.ciphertext
        );
        expect(await secrets.get("refresh")).toBe("second-secret-value");
        const persisted = await Effect.runPromise(tables.loadSubset(handles));
        expect(persisted).toHaveLength(1);
        expect(JSON.stringify(persisted)).not.toContain("secret-value");
        expect(await createEncryptedSecretStore(runtime).get("refresh")).toBe("second-secret-value");
        await secrets.delete("refresh");
        expect(await secrets.get("refresh")).toBeUndefined();
        expect(await Effect.runPromise(tables.loadSubset(handles))).toEqual([]);
    } finally {
        await runtime.cleanup?.();
    }
    await expect(secrets.get("refresh")).rejects.toThrow(/disposed|closed/i);
});
