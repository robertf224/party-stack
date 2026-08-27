import { createHash } from "node:crypto";
import { getAllBackends, type SecretStorageBackend } from "cross-keychain";
import type { SecretStore } from "@party-stack/runtime";

const OS_BACKEND_IDS = new Set([
    "native-macos",
    "macos",
    "native-linux",
    "linux",
    "native-windows",
    "windows",
]);

export interface NodeSecretStoreOptions {
    service: string;
    backend?: SecretStorageBackend | Promise<SecretStorageBackend>;
}

async function selectOSKeychainBackend(): Promise<SecretStorageBackend> {
    const candidates = (await getAllBackends()).filter((backend) => OS_BACKEND_IDS.has(backend.id));
    if (candidates.length === 0) {
        throw new Error(
            "No OS keychain is available. Install or enable macOS Keychain, Windows Credential Manager, or a Linux Secret Service provider."
        );
    }
    return candidates.reduce((selected, candidate) =>
        candidate.priority > selected.priority ? candidate : selected
    );
}

function encodeIdentifier(value: string): string {
    return `party-stack.${createHash("sha256").update(value).digest("hex")}`;
}

export class NodeSecretStore implements SecretStore {
    readonly #service: string;
    readonly #backend: Promise<SecretStorageBackend>;

    constructor(options: NodeSecretStoreOptions) {
        this.#service = encodeIdentifier(options.service);
        this.#backend = Promise.resolve(options.backend ?? selectOSKeychainBackend());
    }

    async get(key: string): Promise<string | undefined> {
        const backend = await this.#backend;
        return (await backend.getPassword(this.#service, encodeIdentifier(key))) ?? undefined;
    }

    async set(key: string, value: string): Promise<void> {
        const backend = await this.#backend;
        await backend.setPassword(this.#service, encodeIdentifier(key), value);
    }

    async delete(key: string): Promise<void> {
        const backend = await this.#backend;
        const account = encodeIdentifier(key);
        if ((await backend.getPassword(this.#service, account)) === null) {
            return;
        }
        await backend.deletePassword(this.#service, account);
    }
}
