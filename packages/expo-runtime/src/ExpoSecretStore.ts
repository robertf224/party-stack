import { RuntimeError, type SecretStore } from "@party-stack/runtime";
import { Effect } from "effect";
import { deleteItemAsync, getItemAsync, setItemAsync } from "expo-secure-store";

// https://docs.expo.dev/versions/latest/sdk/securestore#securestoresetitemkey-value-options
function encodeKey(value: string): string {
    const bytes = new TextEncoder().encode(value);
    return `party-stack.${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function makeSecretStore(prefix: string): SecretStore {
    const key = (value: string) => encodeKey(JSON.stringify([prefix, value]));
    const operation = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({
            try: run,
            catch: () =>
                new RuntimeError({ operation: "secrets", cause: new Error("SecureStore operation failed.") }),
        });
    return {
        get: (id) => operation(() => getItemAsync(key(id))).pipe(Effect.map((value) => value ?? undefined)),
        set: (id, value) => operation(() => setItemAsync(key(id), value)),
        delete: (id) => operation(() => deleteItemAsync(key(id))),
    };
}
