import { createLocalCollection, type RuntimeAdapter, type SecretStore } from "@party-stack/runtime";
import { createEncryptedSecretStore } from "@party-stack/runtime";
import { eq, queryOnce } from "@tanstack/db";

interface StoredSecret {
    key: string;
    value: string;
}

export interface OAuthSecretStore extends SecretStore {
    cleanup(): Promise<void>;
}

export async function resolveOAuthSecretStore(options: {
    runtime: RuntimeAdapter;
    scope?: import("effect").Scope.Scope;
    clientId: string;
    dangerouslyPersistSecrets?: boolean;
}): Promise<OAuthSecretStore> {
    if (options.runtime.encryptionKeyring) {
        return { ...createEncryptedSecretStore(options.runtime), cleanup: async () => {} };
    }
    if (options.runtime.secrets) {
        return {
            get: (key) => options.runtime.secrets!.get(key),
            set: (key, value) => options.runtime.secrets!.set(key, value),
            delete: (key) => options.runtime.secrets!.delete(key),
            cleanup: () => Promise.resolve(),
        };
    }
    if (!options.dangerouslyPersistSecrets) {
        throw new Error(
            "OAuth requires RuntimeAdapter.secrets. Set dangerouslyPersistSecrets to store OAuth secrets in ordinary local persistence."
        );
    }
    if (!options.runtime.tables) {
        throw new Error("The OAuth secret fallback requires owned Tables storage.");
    }
    const records = createLocalCollection<StoredSecret, string>({
        name: `oauth:${encodeURIComponent(options.clientId)}:secrets`,
        getKey: (record) => record.key,
        runtime: options.runtime,
        scope: options.scope,
        schemaVersion: 1,
    });
    const find = (key: string) =>
        queryOnce((q) =>
            q
                .from({ secret: records })
                .where(({ secret }) => eq(secret.key, key))
                .findOne()
        );
    return {
        get: async (key) => (await find(key))?.value,
        async set(key, value) {
            const transaction = (await find(key))
                ? records.update(key, { optimistic: false }, (record) => {
                      record.value = value;
                  })
                : records.insert({ key, value }, { optimistic: false });
            await transaction.isPersisted.promise;
        },
        async delete(key) {
            if (!(await find(key))) return;
            const transaction = records.delete(key, {
                optimistic: false,
            });
            await transaction.isPersisted.promise;
        },
        cleanup: () => records.cleanup(),
    };
}
