import { Encrypted as EncryptedSchema, TemporalTimestamp } from "@party-stack/ontology-spec/effect";
import { Effect, Result, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
import * as Memory from "../memory/tables.js";
import { makeEncryptedValues } from "./index.js";

const keyring = async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    return {
        active: Effect.succeed({ id: "test-key-1", key }),
        get: (id: string) => Effect.succeed(id === "test-key-1" ? key : undefined),
    };
};

test("encrypted handles round-trip without plaintext or keys and decrypt only explicitly", async () => {
    const keys = await keyring();
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const values = makeEncryptedValues("test", tables, keys);
            const plaintext = Schema.Struct({ token: Schema.String, at: TemporalTimestamp });
            const value = {
                token: "sensitive-token-for-test",
                at: Temporal.Instant.from("2026-10-19T00:00:00.123456789Z"),
            };
            const handle = yield* values.encrypt(plaintext, value);
            expect(Object.keys(handle)).toEqual(["id"]);
            const encoded = Schema.encodeSync(EncryptedSchema(plaintext))(handle);
            expect(encoded).toEqual(handle);
            const ciphertext = yield* values.ciphertext(handle);
            expect(ciphertext?.format).toBe("aes-gcm-v1");
            expect(JSON.stringify(ciphertext)).not.toContain(value.token);
            expect(Object.keys(ciphertext!)).toEqual(["format", "keyId", "iv", "data"]);
            expect(yield* values.decrypt(plaintext, handle)).toEqual(value);
            const second = yield* values.encrypt(plaintext, value);
            expect((yield* values.ciphertext(second))?.iv).not.toBe(ciphertext?.iv);
            yield* values.evict(handle);
            expect(yield* values.ciphertext(handle)).toBeUndefined();
            const missing = yield* Effect.result(values.decrypt(plaintext, handle));
            expect(
                Result.isFailure(missing) &&
                    missing.failure._tag === "EncryptionError" &&
                    missing.failure.kind
            ).toBe("MissingCiphertext");
            yield* values.importCiphertext(handle, ciphertext!);
            expect(yield* values.decrypt(plaintext, handle)).toEqual(value);
        })
    );
});

test("ciphertext authentication binds its handle and namespace; keys and plaintext types remain required", async () => {
    const keys = await keyring();
    await Effect.runPromise(
        Effect.gen(function* () {
            const tables = yield* Memory.make();
            const values = makeEncryptedValues("owner", tables, keys);
            const handle = yield* values.encrypt(Schema.String, "private-test-value");
            const ciphertext = (yield* values.ciphertext(handle))!;
            const errorKind = <A>(effect: Effect.Effect<A, unknown>) =>
                Effect.map(Effect.result(effect), (result) =>
                    Result.isFailure(result) ? (result.failure as { kind?: string }).kind : undefined
                );
            const transplanted = { id: "different-id" };
            yield* values.importCiphertext(transplanted, ciphertext);
            expect(yield* errorKind(values.decrypt(Schema.String, transplanted))).toBe("InvalidCiphertext");
            const other = makeEncryptedValues("different-namespace", tables, keys);
            yield* other.importCiphertext(handle, ciphertext);
            expect(yield* errorKind(other.decrypt(Schema.String, handle))).toBe("InvalidCiphertext");
            const noKeys = makeEncryptedValues("owner", tables, {
                ...keys,
                get: () => Effect.succeed(undefined),
            });
            expect(yield* errorKind(noKeys.decrypt(Schema.String, handle))).toBe("MissingKey");
            expect(yield* errorKind(values.decrypt(Schema.Number, handle as never))).toBe("InvalidValue");
            yield* values.importCiphertext(handle, {
                ...ciphertext,
                data: `${ciphertext.data[0] === "A" ? "B" : "A"}${ciphertext.data.slice(1)}`,
            });
            expect(yield* errorKind(values.decrypt(Schema.String, handle))).toBe("InvalidCiphertext");
        })
    );
});
