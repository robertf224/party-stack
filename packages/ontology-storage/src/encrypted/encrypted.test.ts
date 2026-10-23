import { Encrypted as EncryptedSchema, TemporalTimestamp } from "@party-stack/ontology-spec/effect";
import { Effect, Result, Schema } from "effect";
import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";
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

test("ciphertext is self-contained and round-trips Temporal without any storage service", async () => {
    const keys = await keyring();
    await Effect.runPromise(
        Effect.gen(function* () {
            const values = makeEncryptedValues("test", keys);
            const schema = Schema.Struct({ token: Schema.String, at: TemporalTimestamp });
            const plaintext = {
                token: "sensitive-token-test",
                at: Temporal.Instant.from("2026-10-19T00:00:00.123456789Z"),
            };
            const encrypted = yield* values.encrypt(schema, plaintext);
            expect(Object.keys(encrypted)).toEqual(["ciphertext"]);
            expect(JSON.stringify(encrypted)).not.toContain(plaintext.token);
            expect(Schema.encodeSync(EncryptedSchema(schema))(encrypted)).toEqual(encrypted);
            expect(
                yield* makeEncryptedValues("test", keys).decrypt(schema, structuredClone(encrypted))
            ).toEqual(plaintext);
            expect((yield* values.encrypt(schema, plaintext)).ciphertext).not.toBe(encrypted.ciphertext);
        })
    );
});

test("authentication rejects tampering, other namespaces and missing keys; plaintext schema remains required", async () => {
    const keys = await keyring();
    await Effect.runPromise(
        Effect.gen(function* () {
            const values = makeEncryptedValues("owner", keys);
            const encrypted = yield* values.encrypt(Schema.String, "private-test-value");
            const kind = <A>(effect: Effect.Effect<A, unknown>) =>
                Effect.map(Effect.result(effect), (result) =>
                    Result.isFailure(result) ? (result.failure as { kind?: string }).kind : undefined
                );
            expect(yield* kind(makeEncryptedValues("other", keys).decrypt(Schema.String, encrypted))).toBe(
                "InvalidCiphertext"
            );
            expect(
                yield* kind(
                    makeEncryptedValues("owner", { ...keys, get: () => Effect.succeed(undefined) }).decrypt(
                        Schema.String,
                        encrypted
                    )
                )
            ).toBe("MissingKey");
            const wrongKeys = yield* Effect.promise(keyring);
            expect(
                yield* kind(makeEncryptedValues("owner", wrongKeys).decrypt(Schema.String, encrypted))
            ).toBe("InvalidCiphertext");
            expect(yield* kind(values.decrypt(Schema.Number, encrypted as never))).toBe("InvalidValue");
            const prefix = "party-stack:encrypted:v1:";
            const envelope = JSON.parse(encrypted.ciphertext.slice(prefix.length));
            envelope.data = (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1);
            expect(
                yield* kind(values.decrypt(Schema.String, { ciphertext: prefix + JSON.stringify(envelope) }))
            ).toBe("InvalidCiphertext");
            expect(yield* kind(values.decrypt(Schema.String, { ciphertext: "CIPHER::remote" }))).toBe(
                "InvalidCiphertext"
            );
        })
    );
});
