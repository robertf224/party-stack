import {
    createDurableObjectSQLiteDatabase,
    type DurableObjectSQLiteDatabase,
} from "@party-stack/cloudflare-sqlite-ontology";
import {
    createSQLiteBackendInstallation,
    createSQLiteOntologyRoute,
    type CreateSQLiteOntologyRouteOptions,
    type SQLiteAttachmentStorageOptions,
} from "@party-stack/sqlite-ontology";
import type { BackendConnectionAdapterProvider } from "@party-stack/connections";
import type { OntologyBackendInstallation } from "@party-stack/ontology";
import {
    createCloudflareRuntimeHost,
    type CloudflareRuntimeHost,
    type CreateCloudflareRuntimeOptions,
} from "./createCloudflareRuntime.js";
import { R2BlobBytesStore, type R2BucketLike } from "./R2BlobBytesStore.js";

export type CloudflareSQLiteAttachmentStorage = "r2" | "sqlite" | SQLiteAttachmentStorageOptions;

export type CreateCloudflareSQLiteOntologyRouteOptions = Omit<
    CreateSQLiteOntologyRouteOptions,
    "attachmentStorage"
> & {
    /**
     * Defaults to R2. Choose "sqlite" only for small/local
     * installations that intentionally keep authoritative bytes inline.
     */
    attachmentStorage?: CloudflareSQLiteAttachmentStorage;
    legacyAttachmentSqlNamespace?: string;
    r2KeyPrefix?: string;
};

export function createCloudflareSQLiteOntologyRoute(
    options: CreateCloudflareSQLiteOntologyRouteOptions
): CreateCloudflareSQLiteOntologyRouteOptions {
    return options;
}

export interface CreateCloudflareSQLiteBackendInstallationOptions<
    AuthenticationClient extends object = object,
> {
    installationId: string;
    storage: CreateCloudflareRuntimeOptions["storage"];
    bucket: R2BucketLike;
    connections: BackendConnectionAdapterProvider<AuthenticationClient>;
    routes: readonly CreateCloudflareSQLiteOntologyRouteOptions[];
    createContext?: (userId: string, ontologyId: string) => Record<string, unknown>;
}

export interface CloudflareSQLiteBackendInstallation<AuthenticationClient extends object = object>
    extends OntologyBackendInstallation<AuthenticationClient> {
    readonly database: DurableObjectSQLiteDatabase;
    readonly runtimeHost: CloudflareRuntimeHost;
    /**
     * Cleans up the installation and deletes the complete Durable Object
     * SQLite database plus every installation-scoped R2 object.
     */
    destroyInstallation(): Promise<void>;
}

function attachmentStorageForRoute(options: {
    installationId: string;
    bucket: R2BucketLike;
    route: CreateCloudflareSQLiteOntologyRouteOptions;
}): SQLiteAttachmentStorageOptions | undefined {
    const { attachmentStorage, legacyAttachmentSqlNamespace, r2KeyPrefix } = options.route;
    if (attachmentStorage === "sqlite") {
        return legacyAttachmentSqlNamespace ? { legacyAttachmentSqlNamespace } : undefined;
    }
    if (attachmentStorage && typeof attachmentStorage === "object") {
        return {
            ...attachmentStorage,
            ...(legacyAttachmentSqlNamespace
                ? {
                      legacyAttachmentSqlNamespace,
                  }
                : {}),
        };
    }
    return {
        external: {
            bytes: new R2BlobBytesStore({
                bucket: options.bucket,
                installationId: options.installationId,
                owner: "ontology",
                namespace: options.route.ontologyId,
            }),
            ...(r2KeyPrefix ? { keyPrefix: r2KeyPrefix } : {}),
        },
        ...(legacyAttachmentSqlNamespace ? { legacyAttachmentSqlNamespace } : {}),
    };
}

export async function createCloudflareSQLiteBackendInstallation<AuthenticationClient extends object = object>(
    options: CreateCloudflareSQLiteBackendInstallationOptions<AuthenticationClient>
): Promise<CloudflareSQLiteBackendInstallation<AuthenticationClient>> {
    const database = createDurableObjectSQLiteDatabase(options.storage);
    const runtimeHost = createCloudflareRuntimeHost({
        installationId: options.installationId,
        storage: options.storage,
        bucket: options.bucket,
    });
    try {
        const installation = await createSQLiteBackendInstallation({
            installationId: options.installationId,
            database,
            connections: options.connections,
            runtime: runtimeHost.runtime,
            routes: options.routes.map((route) => {
                const {
                    attachmentStorage: _attachmentStorage,
                    legacyAttachmentSqlNamespace: _legacyAttachmentSqlNamespace,
                    r2KeyPrefix: _r2KeyPrefix,
                    ...sqliteRoute
                } = route;
                void _attachmentStorage;
                void _legacyAttachmentSqlNamespace;
                void _r2KeyPrefix;
                return createSQLiteOntologyRoute({
                    ...sqliteRoute,
                    attachmentStorage: attachmentStorageForRoute({
                        installationId: options.installationId,
                        bucket: options.bucket,
                        route,
                    }),
                });
            }),
            createContext: options.createContext,
        });
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = () => {
            cleanupPromise ??= (async () => {
                await installation.cleanup();
                await runtimeHost.cleanup();
            })();
            return cleanupPromise;
        };
        let destroyPromise: Promise<void> | undefined;
        return {
            ...installation,
            database,
            runtimeHost,
            cleanup,
            destroyInstallation() {
                if (!destroyPromise) {
                    const attempt = cleanup().then(() => runtimeHost.destroyInstallation());
                    destroyPromise = attempt;
                    void attempt.catch(() => {
                        if (destroyPromise === attempt) {
                            destroyPromise = undefined;
                        }
                    });
                }
                return destroyPromise;
            },
        };
    } catch (error) {
        await runtimeHost.cleanup();
        throw error;
    }
}
