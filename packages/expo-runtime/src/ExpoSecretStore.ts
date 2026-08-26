import {
    deleteItemAsync,
    getItemAsync,
    setItemAsync,
} from "expo-secure-store";
import type { SecretStore } from "@party-stack/runtime";

export class ExpoSecretStore implements SecretStore {
    constructor(private readonly prefix: string) {}

    get(key: string): Promise<string | undefined> {
        return getItemAsync(this.key(key)).then((value) => value ?? undefined);
    }

    set(key: string, value: string): Promise<void> {
        return setItemAsync(this.key(key), value);
    }

    delete(key: string): Promise<void> {
        return deleteItemAsync(this.key(key));
    }

    private key(key: string): string {
        return `${this.prefix}:${encodeURIComponent(key)}`;
    }
}
