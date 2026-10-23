import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";
import type { SecretStore } from "@party-stack/runtime";
import type { SecureStoreOptions } from "expo-secure-store";

// https://docs.expo.dev/versions/latest/sdk/securestore#securestoresetitemkey-value-options
function encodeKey(value: string): string {
    const bytes = new TextEncoder().encode(value);
    return `party-stack.${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class ExpoSecretStore implements SecretStore {
    constructor(
        private readonly prefix: string,
        private readonly options?: SecureStoreOptions
    ) {}

    get(key: string): Promise<string | undefined> {
        return (this.options ? getItemAsync(this.key(key), this.options) : getItemAsync(this.key(key))).then(
            (value) => value ?? undefined
        );
    }

    set(key: string, value: string): Promise<void> {
        return this.options
            ? setItemAsync(this.key(key), value, this.options)
            : setItemAsync(this.key(key), value);
    }

    delete(key: string): Promise<void> {
        return this.options ? deleteItemAsync(this.key(key), this.options) : deleteItemAsync(this.key(key));
    }

    private key(key: string): string {
        return encodeKey(JSON.stringify([this.prefix, key]));
    }
}
