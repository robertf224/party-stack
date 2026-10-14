import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";

export function hashStorageName(value: string): Promise<string> {
    return digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
}
