import { createDurableObjectSQLiteDatabase } from "@party-stack/cloudflare-sqlite-ontology";
import { SingleProcessCoordination } from "@party-stack/coordination";
import { defineRuntime, type PersistenceAdapter, type RuntimeAdapterProvider } from "@party-stack/runtime";
import type { DurableObjectSQLiteStorage } from "@party-stack/cloudflare-sqlite-ontology";
import { DurableObjectPersistenceAdapter } from "./DurableObjectPersistenceAdapter.js";
import { DurableObjectSecretStore } from "./DurableObjectSecretStore.js";
import {
    destroyR2Installation,
    R2BlobBytesStore,
    type R2BlobBytesStoreOptions,
    type R2BucketLike,
} from "./R2BlobBytesStore.js";
import { ServerNetworkConnectivity } from "./ServerNetworkConnectivity.js";
import type { DurableObjectStorageLike } from "@tanstack/cloudflare-durable-objects-db-sqlite-persistence";

export interface CreateCloudflareRuntimeOptions {
    installationId: string;
    storage: DurableObjectSQLiteStorage & DurableObjectStorageLike;
    bucket: R2BucketLike;
}

export interface CloudflareRuntimeHost {
    readonly runtime: RuntimeAdapterProvider;
    readonly persistence: PersistenceAdapter;
    cleanup(): Promise<void>;
    destroyInstallation(): Promise<void>;
}

export function createCloudflareRuntimeHost(options: CreateCloudflareRuntimeOptions): CloudflareRuntimeHost {
    const database = createDurableObjectSQLiteDatabase(options.storage);
    const persistence = new DurableObjectPersistenceAdapter(database, options.storage);
    const connectivity = new ServerNetworkConnectivity();
    const cleanups = new Set<() => Promise<void>>();
    const coordinationByScope = new Map<
        string,
        {
            coordination: SingleProcessCoordination;
            closing?: Promise<void>;
            persistence: PersistenceAdapter;
            references: number;
        }
    >();
    const destroyingScopes = new Set<string>();
    let closed = false;
    let cleanupPromise: Promise<void> | undefined;

    const runtime = defineRuntime((owner, namespace) => {
        if (closed) {
            throw new Error(`Cloudflare runtime host "${options.installationId}" is closed.`);
        }
        const scopeKey = JSON.stringify([owner, namespace]);
        if (destroyingScopes.has(scopeKey)) {
            throw new Error(`Cloudflare runtime scope "${owner}/${namespace}" is being destroyed.`);
        }
        let coordinationHandle = coordinationByScope.get(scopeKey);
        if (coordinationHandle?.references === 0 && coordinationHandle.closing) {
            throw new Error(`Cloudflare runtime scope "${owner}/${namespace}" is still closing; retry.`);
        }
        if (coordinationHandle && coordinationHandle.references > 0) {
            throw new Error(`Cloudflare runtime scope "${owner}/${namespace}" is already active.`);
        }
        if (!coordinationHandle) {
            coordinationHandle = {
                coordination: new SingleProcessCoordination({
                    scope: `party-stack:${options.installationId}:${scopeKey}`,
                }),
                persistence: persistence.scoped(owner, namespace),
                references: 0,
            };
            coordinationByScope.set(scopeKey, coordinationHandle);
        }
        const activeCoordinationHandle = coordinationHandle;
        const coordination = activeCoordinationHandle.coordination;
        activeCoordinationHandle.references++;
        const blobOptions: R2BlobBytesStoreOptions = {
            bucket: options.bucket,
            installationId: options.installationId,
            owner,
            namespace,
        };
        const blobBytes = new R2BlobBytesStore(blobOptions);
        const secrets = new DurableObjectSecretStore(database, owner, namespace);
        const scopedPersistence = activeCoordinationHandle.persistence;
        let runtimeCleanup: Promise<void> | undefined;
        const cleanup = () => {
            runtimeCleanup ??= (async () => {
                try {
                    await blobBytes.close();
                    activeCoordinationHandle.references--;
                    if (activeCoordinationHandle.references === 0) {
                        activeCoordinationHandle.closing = activeCoordinationHandle.coordination.close();
                        await activeCoordinationHandle.closing;
                        if (coordinationByScope.get(scopeKey) === activeCoordinationHandle) {
                            coordinationByScope.delete(scopeKey);
                        }
                    }
                } finally {
                    cleanups.delete(cleanup);
                }
            })();
            return runtimeCleanup;
        };
        cleanups.add(cleanup);
        return {
            owner,
            namespace,
            blobBytes,
            coordination,
            connectivity,
            persistence: scopedPersistence,
            secrets,
            cleanup,
            async destroy() {
                const currentGeneration = coordinationByScope.get(scopeKey);
                if (
                    activeCoordinationHandle.references > 0 ||
                    (currentGeneration !== undefined && currentGeneration !== activeCoordinationHandle)
                ) {
                    throw new Error(
                        `Cannot destroy active Cloudflare runtime scope "${owner}/${namespace}".`
                    );
                }
                destroyingScopes.add(scopeKey);
                try {
                    persistence.destroyNamespace(owner, namespace);
                    secrets.destroy();
                    await blobBytes.destroy();
                } finally {
                    destroyingScopes.delete(scopeKey);
                }
            },
        };
    });

    const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
            closed = true;
            await Promise.all([...cleanups].map((close) => close()));
            cleanups.clear();
        })();
        return cleanupPromise;
    };

    return {
        runtime,
        persistence,
        cleanup,
        async destroyInstallation() {
            await cleanup();
            await destroyR2Installation(options.bucket, options.installationId);
            await options.storage.deleteAll();
        },
    };
}

export function createCloudflareRuntime(options: CreateCloudflareRuntimeOptions): RuntimeAdapterProvider {
    return createCloudflareRuntimeHost(options).runtime;
}
