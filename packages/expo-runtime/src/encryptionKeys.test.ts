import {
    makeEncryptedValues,
    type EncryptionKey,
    type EncryptionKeyringService,
} from "@party-stack/ontology-storage/encrypted";
import { Effect, Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { nativeKeyCodec } from "./encryptionKeys.js";

// Model Expo's documented native AES byte/nonce/tag API with Web Crypto. The
// portable envelope must interoperate in both directions, including authenticated context.
vi.mock("expo-crypto", () => ({
    AESEncryptionKey: {
        generate: async () => ({
            encoded: async () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
        }),
        import: (encoded: string) =>
            crypto.subtle.importKey(
                "raw",
                Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
                "AES-GCM",
                false,
                ["encrypt", "decrypt"]
            ),
    },
    aesEncryptAsync: async (
        bytes: Uint8Array<ArrayBuffer>,
        key: CryptoKey,
        options: { nonce: { bytes: Uint8Array<ArrayBuffer> }; additionalData: Uint8Array<ArrayBuffer> }
    ) => {
        const data = await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: options.nonce.bytes,
                additionalData: options.additionalData,
                tagLength: 128,
            },
            key,
            bytes
        );
        return {
            ciphertext: ({ includeTag }: { includeTag: boolean }) => {
                expect(includeTag).toBe(true);
                return new Uint8Array(data);
            },
        };
    },
    AESSealedData: {
        fromParts: (iv: Uint8Array, ciphertext: Uint8Array, length: number) => {
            expect(length).toBe(16);
            return { iv, ciphertext };
        },
    },
    aesDecryptAsync: async (
        data: { iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> },
        key: CryptoKey,
        options: { additionalData: Uint8Array<ArrayBuffer> }
    ) =>
        new Uint8Array(
            await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: data.iv, additionalData: options.additionalData, tagLength: 128 },
                key,
                data.ciphertext
            )
        ),
}));
const ring = (key: EncryptionKey): EncryptionKeyringService => ({
    active: Effect.succeed({ id: "key", key }),
    get: () => Effect.succeed(key),
});

test("native Expo AES and Web Crypto read each other's authenticated ciphertext envelopes", async () => {
    const encoded = await nativeKeyCodec.generate();
    const native = makeEncryptedValues("owner", ring(await nativeKeyCodec.import(encoded)));
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"]
    );
    const web = makeEncryptedValues("owner", ring(key));
    const first = await Effect.runPromise(native.encrypt(Schema.String, "native value"));
    expect(await Effect.runPromise(web.decrypt(Schema.String, first))).toBe("native value");
    const second = await Effect.runPromise(web.encrypt(Schema.String, "web value"));
    expect(await Effect.runPromise(native.decrypt(Schema.String, second))).toBe("web value");
    const otherOwner = makeEncryptedValues("other-owner", ring(await nativeKeyCodec.import(encoded)));
    await expect(Effect.runPromise(otherOwner.decrypt(Schema.String, first))).rejects.toMatchObject({
        _tag: "EncryptionError",
        kind: "InvalidCiphertext",
    });
});
