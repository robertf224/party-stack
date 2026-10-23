import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import type { KeyMaterialCodec } from "@party-stack/runtime";

/** Native AES-GCM uses the same authenticated envelope as the Web Crypto implementation. */
export const nativeKeyCodec: KeyMaterialCodec = {
    generate: async () => (await AESEncryptionKey.generate()).encoded("base64"),
    import: async (encoded) => {
        const key = await AESEncryptionKey.import(encoded, "base64");
        return {
            encrypt: async (plaintext, iv, additionalData) => {
                const sealed = await aesEncryptAsync(plaintext, key, {
                    nonce: { bytes: iv },
                    additionalData,
                });
                return sealed.ciphertext({ includeTag: true });
            },
            decrypt: (ciphertext, iv, additionalData) =>
                aesDecryptAsync(AESSealedData.fromParts(iv, ciphertext, 16), key, { additionalData }),
        };
    },
};
