import { BackendError } from "@party-stack/ontology-backend";
import { o } from "@party-stack/ontology-spec";
import { Cause, Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { makeReplicaDecryption } from "./decrypt.js";
import type { OntologyIR } from "@party-stack/ontology-spec";

const ir: OntologyIR = {
    types: [],
    linkTypes: [],
    actionTypes: [],
    queryFunctionTypes: [],
    objectTypes: [
        {
            name: "Person",
            displayName: "Person",
            pluralDisplayName: "People",
            primaryKey: "id",
            properties: [
                { name: "id", displayName: "ID", type: o.string({}) },
                { name: "secret", displayName: "Secret", type: o.encrypted({ type: o.string({}) }) },
            ],
        },
    ],
};
const handle = {
    ciphertext: "ciphertext",
    source: { objectType: "Person", primaryKey: "1", property: "secret" },
};
const secret = "private-plaintext-and-key-material";

test("decryption preserves safe retry timing without exposing provider details", async () => {
    const service = makeReplicaDecryption({
        ir,
        namespace: "test",
        cache: { get: () => Effect.succeed(undefined), put: () => Effect.void },
        backend: {
            sourceId: "authority",
            encrypted: {
                decrypt: () =>
                    Effect.fail(
                        new BackendError({
                            operation: "provider",
                            kind: "RateLimited",
                            retryable: true,
                            retryAfterMs: 1234,
                            message: secret,
                            cause: new Error(secret),
                            issues: [{ message: secret }],
                        })
                    ),
            },
        },
    });
    const result = await Effect.runPromise(Effect.result(service.decrypt(handle)));
    expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
            kind: "RateLimited",
            retryable: true,
            retryAfterMs: 1234,
            message: "Decryption failed.",
        },
    });
    const error = result._tag === "Failure" ? result.failure : undefined;
    expect(error?.cause).toBeUndefined();
    expect(error?.issues).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
});

test.each(["provider", "cache-read", "key", "cache-write"] as const)(
    "%s defects cannot leak secrets across decryption",
    async (where) => {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
        ]);
        const service = makeReplicaDecryption({
            ir,
            namespace: "test",
            keyring: {
                active:
                    where === "key" ? Effect.die(new Error(secret)) : Effect.succeed({ id: "device", key }),
                get: () => Effect.succeed(key),
            },
            cache: {
                get: () =>
                    where === "cache-read" ? Effect.die(new Error(secret)) : Effect.succeed(undefined),
                put: () => (where === "cache-write" ? Effect.die(new Error(secret)) : Effect.void),
            },
            backend: {
                sourceId: "authority",
                encrypted: {
                    decrypt: () =>
                        where === "provider"
                            ? Effect.die(new Error(secret))
                            : Effect.succeed({ value: secret, ciphertext: handle.ciphertext }),
                },
            },
        });
        const result = await Effect.runPromise(Effect.result(service.decrypt(handle, { cache: true })));
        expect(result).toMatchObject({
            _tag: "Failure",
            failure: { kind: "Internal", retryable: false, message: "Decryption failed." },
        });
        const error = result._tag === "Failure" ? result.failure : undefined;
        expect(error?.cause).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(secret);
    }
);

test("decryption interruption remains interruption", async () => {
    const service = makeReplicaDecryption({
        ir,
        namespace: "test",
        cache: { get: () => Effect.succeed(undefined), put: () => Effect.void },
        backend: { sourceId: "authority", encrypted: { decrypt: () => Effect.interrupt } },
    });
    const exit = await Effect.runPromiseExit(service.decrypt(handle));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});
