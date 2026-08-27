import {
    createLocalCollection,
    type RuntimeAdapter,
    type SecretStore,
} from "@party-stack/runtime";

interface StoredSecret {
    key: string;
    value: string;
}

export interface OAuthSecretStore extends SecretStore {
    cleanup(): Promise<void>;
}

export async function resolveOAuthSecretStore(options: {
    runtime: RuntimeAdapter;
    clientId: string;
    dangerouslyPersistSecrets?: boolean;
}): Promise<OAuthSecretStore> {
    if (options.runtime.secrets) {
        return {
            get: (key) => options.runtime.secrets!.get(key),
            set: (key, value) =>
                options.runtime.secrets!.set(key, value),
            delete: (key) =>
                options.runtime.secrets!.delete(key),
            cleanup: () => Promise.resolve(),
        };
    }
    if (!options.dangerouslyPersistSecrets) {
        throw new Error(
            "OAuth requires RuntimeAdapter.secrets. Set dangerouslyPersistSecrets to store OAuth secrets in ordinary local persistence."
        );
    }
    if (!options.runtime.persistence) {
        throw new Error(
            "The OAuth secret fallback requires runtime persistence."
        );
    }
    const records = createLocalCollection<
        StoredSecret,
        string
    >({
        name: `oauth:${encodeURIComponent(options.clientId)}:secrets`,
        getKey: (record) => record.key,
        runtime: options.runtime,
        schemaVersion: 1,
    });
    await records.preload();
    return {
        get: (key) =>
            Promise.resolve(records.get(key)?.value),
        async set(key, value) {
            const transaction = records.get(key)
                ? records.update(
                      key,
                      { optimistic: false },
                      (record) => {
                          record.value = value;
                      }
                  )
                : records.insert(
                      { key, value },
                      { optimistic: false }
                  );
            await transaction.isPersisted.promise;
        },
        async delete(key) {
            if (!records.get(key)) return;
            const transaction = records.delete(key, {
                optimistic: false,
            });
            await transaction.isPersisted.promise;
        },
        cleanup: () => records.cleanup(),
    };
}
