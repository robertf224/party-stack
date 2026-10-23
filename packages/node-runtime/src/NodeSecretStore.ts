import { createHash } from "node:crypto";
import { make as makeNodeKeyring, type NodeKeyringService } from "@party-stack/effect-node-keyring";
import { Effect, Redacted } from "effect";
import type { SecretStore } from "@party-stack/runtime";

export interface NodeSecretStoreOptions {
    service: string;
}
function encodeIdentifier(value: string): string {
    return `party-stack.${createHash("sha256").update(value).digest("hex")}`;
}

/** Promise facade for the native Effect service. Constructing a runtime does not open a keychain. */
export class NodeSecretStore implements SecretStore {
    readonly #service: string;
    #keyring?: Promise<NodeKeyringService>;
    constructor(options: NodeSecretStoreOptions) {
        this.#service = encodeIdentifier(options.service);
    }
    async get(key: string): Promise<string | undefined> {
        const keyring = await this.#getKeyring();
        const value = await Effect.runPromise(keyring.getPassword(this.#service, encodeIdentifier(key)));
        return value === undefined ? undefined : Redacted.value(value);
    }
    async set(key: string, value: string): Promise<void> {
        const keyring = await this.#getKeyring();
        await Effect.runPromise(
            keyring.setPassword(this.#service, encodeIdentifier(key), Redacted.make(value))
        );
    }
    async delete(key: string): Promise<void> {
        const keyring = await this.#getKeyring();
        await Effect.runPromise(keyring.deleteCredential(this.#service, encodeIdentifier(key)));
    }
    #getKeyring(): Promise<NodeKeyringService> {
        this.#keyring ??= Effect.runPromise(makeNodeKeyring);
        return this.#keyring;
    }
}
