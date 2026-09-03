import {
    createSQLiteOntologyBackendAdapter,
    type SQLiteAttachmentStorageOptions,
    type SQLiteDatabase,
    type SQLiteStatement,
} from "@party-stack/sqlite-ontology";
import type {
    OntologyBackendAdapter,
    OntologyBackendAdapterProvider,
    OntologyIR,
    OntologyMutatorRegistry,
    OntologyQueryFunctionRegistry,
} from "@party-stack/ontology";

export interface DurableObjectSqlCursor {
    toArray(): Record<string, unknown>[];
}

export type DurableObjectSqlBinding = ArrayBuffer | string | number | null;

export interface DurableObjectSqlStorage {
    exec(query: string, ...bindings: DurableObjectSqlBinding[]): DurableObjectSqlCursor;
}

export interface DurableObjectSQLiteStorage {
    readonly sql: DurableObjectSqlStorage;
    transactionSync<Result>(callback: () => Result): Result;
    deleteAll(): Promise<void>;
}

export interface DurableObjectSQLiteDatabase extends SQLiteDatabase {
    destroy(): Promise<void>;
}

function normalizeBinding(binding: unknown): DurableObjectSqlBinding {
    if (ArrayBuffer.isView(binding)) {
        return new Uint8Array(binding.buffer, binding.byteOffset, binding.byteLength).slice().buffer;
    }
    if (
        binding === null ||
        typeof binding === "string" ||
        typeof binding === "number" ||
        binding instanceof ArrayBuffer
    ) {
        return binding;
    }
    throw new TypeError(`Unsupported Durable Object SQL binding: ${typeof binding}.`);
}

function createStatement(sql: DurableObjectSqlStorage, query: string): SQLiteStatement {
    const execute = (bindings: unknown[]) => sql.exec(query, ...bindings.map(normalizeBinding));
    return {
        all: (...bindings) => execute(bindings).toArray(),
        get: (...bindings) => execute(bindings).toArray()[0],
        run: (...bindings) => execute(bindings),
    };
}

export function createDurableObjectSQLiteDatabase(
    storage: DurableObjectSQLiteStorage
): DurableObjectSQLiteDatabase {
    return {
        exec: (sql) => storage.sql.exec(sql),
        prepare: (sql) => createStatement(storage.sql, sql),
        transaction: (callback) => () => {
            storage.transactionSync(callback);
        },
        destroy: () => storage.deleteAll(),
    };
}

export interface R2ObjectBodyLike {
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: {
        contentType?: string;
    };
}

export interface R2ListedObjectLike {
    key: string;
}

export interface R2ObjectsLike {
    objects: readonly R2ListedObjectLike[];
    truncated: boolean;
    cursor?: string;
}

export interface R2BucketLike {
    put(
        key: string,
        value: Blob | ArrayBuffer,
        options?: {
            httpMetadata?: {
                contentType?: string;
            };
        }
    ): Promise<unknown>;
    get(key: string): Promise<R2ObjectBodyLike | null>;
    delete(keys: string | readonly string[]): Promise<void>;
    list(options?: { prefix?: string; cursor?: string }): Promise<R2ObjectsLike>;
}

export class R2AttachmentNotFoundError extends Error {
    constructor(readonly key: string) {
        super(`R2 attachment bytes not found for "${key}".`);
        this.name = "R2AttachmentNotFoundError";
    }
}

async function hashKeyPart(value: string): Promise<string> {
    const bytes = new Uint8Array(value.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index++) {
        view.setUint16(index * 2, value.charCodeAt(index));
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let binary = "";
    for (const byte of digest) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function r2InstallationPrefix(installationId: string): Promise<string> {
    return `party-stack/ontology-attachments/${await hashKeyPart(installationId)}/`;
}

async function r2Prefix(options: { installationId: string; ontologyId: string }): Promise<string> {
    return `${await r2InstallationPrefix(options.installationId)}${await hashKeyPart(options.ontologyId)}/`;
}

async function deleteR2Prefix(bucket: R2BucketLike, prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
        const listed = await bucket.list({
            prefix,
            ...(cursor ? { cursor } : {}),
        });
        const keys = listed.objects.map((object) => object.key);
        if (keys.length > 0) {
            await bucket.delete(keys);
        }
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
}

export interface R2AttachmentBytesStoreOptions {
    bucket: R2BucketLike;
    installationId: string;
    ontologyId: string;
}

export class R2AttachmentBytesStore {
    readonly prefix: Promise<string>;
    private readonly inFlight = new Set<Promise<unknown>>();
    private closed = false;

    constructor(private readonly options: R2AttachmentBytesStoreOptions) {
        this.prefix = r2Prefix(options);
    }

    async key(id: string): Promise<string> {
        return `${await this.prefix}${await hashKeyPart(id)}`;
    }

    private track<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this.closed) {
            return Promise.reject(new Error("R2 attachment byte store is closed."));
        }
        const pending = operation();
        this.inFlight.add(pending);
        void pending.then(
            () => this.inFlight.delete(pending),
            () => this.inFlight.delete(pending)
        );
        return pending;
    }

    write(id: string, blob: Blob): Promise<void> {
        return this.track(async () => {
            await this.options.bucket.put(await this.key(id), blob, {
                httpMetadata: {
                    contentType: blob.type || "application/octet-stream",
                },
            });
        });
    }

    read(id: string): Promise<Blob> {
        return this.track(async () => {
            const key = await this.key(id);
            const object = await this.options.bucket.get(key);
            if (!object) {
                throw new R2AttachmentNotFoundError(key);
            }
            return new Blob([await object.arrayBuffer()], {
                type: object.httpMetadata?.contentType ?? "application/octet-stream",
            });
        });
    }

    delete(id: string): Promise<void> {
        return this.track(async () => {
            await this.options.bucket.delete(await this.key(id));
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        await Promise.allSettled(this.inFlight);
    }

    async destroy(): Promise<void> {
        await this.close();
        await deleteR2Prefix(this.options.bucket, await this.prefix);
    }
}

export async function destroyDurableObjectOntologyStorage(options: {
    storage: DurableObjectSQLiteStorage;
    bucket: R2BucketLike;
    installationId: string;
    /**
     * Closes every LiveOntology/backend using this storage. Invoke the
     * destruction function from an exclusive Durable Object lifecycle gate.
     */
    quiesce(): Promise<void>;
}): Promise<void> {
    await options.quiesce();
    await deleteR2Prefix(options.bucket, await r2InstallationPrefix(options.installationId));
    await options.storage.deleteAll();
}

export type DurableObjectAttachmentStorage = "r2" | "sqlite" | SQLiteAttachmentStorageOptions;

interface DurableObjectOntologyBackendCommonOptions {
    storage: DurableObjectSQLiteStorage;
    installationId: string;
    ontologyId: string;
    name?: string;
    mutators?: OntologyMutatorRegistry;
    queryFunctions?: OntologyQueryFunctionRegistry;
}

type DurableObjectOntologyAttachmentOptions =
    | {
          attachmentStorage?: "r2";
          bucket: R2BucketLike;
      }
    | {
          attachmentStorage: "sqlite" | SQLiteAttachmentStorageOptions;
          bucket?: R2BucketLike;
      };

type DurableObjectOntologyBackendBaseOptions = DurableObjectOntologyBackendCommonOptions &
    DurableObjectOntologyAttachmentOptions;

export type CreateDurableObjectOntologyBackendAdapterOptions = DurableObjectOntologyBackendBaseOptions & {
    ir: OntologyIR;
};

function resolveAttachmentStorage(options: DurableObjectOntologyBackendBaseOptions): {
    storage: SQLiteAttachmentStorageOptions | undefined;
    ownedR2?: R2AttachmentBytesStore;
} {
    if (options.attachmentStorage === "sqlite") {
        return { storage: undefined };
    }
    if (options.attachmentStorage && typeof options.attachmentStorage === "object") {
        return {
            storage: options.attachmentStorage,
        };
    }
    if (!options.bucket) {
        throw new Error("R2 attachment storage requires a bucket.");
    }
    const ownedR2 = new R2AttachmentBytesStore({
        bucket: options.bucket,
        installationId: options.installationId,
        ontologyId: options.ontologyId,
    });
    return {
        storage: {
            external: {
                bytes: ownedR2,
            },
        },
        ownedR2,
    };
}

export function createDurableObjectOntologyBackendAdapter(
    options: CreateDurableObjectOntologyBackendAdapterOptions
): OntologyBackendAdapter {
    const attachmentStorage = resolveAttachmentStorage(options);
    const adapter = createSQLiteOntologyBackendAdapter({
        ir: options.ir,
        database: createDurableObjectSQLiteDatabase(options.storage),
        name: options.name,
        attachmentStorage: attachmentStorage.storage,
        mutators: options.mutators,
        queryFunctions: options.queryFunctions,
    });
    const ownedR2 = attachmentStorage.ownedR2;
    if (!ownedR2) {
        return adapter;
    }
    let cleanupPromise: Promise<void> | undefined;
    return {
        ...adapter,
        cleanup() {
            cleanupPromise ??= Promise.resolve(adapter.cleanup?.()).then(() => ownedR2.close());
            return cleanupPromise;
        },
    };
}

export type CreateDurableObjectOntologyBackendOptions = DurableObjectOntologyBackendBaseOptions;

export function createDurableObjectOntologyBackend(
    options: CreateDurableObjectOntologyBackendOptions
): OntologyBackendAdapterProvider {
    return (ir) =>
        createDurableObjectOntologyBackendAdapter({
            ...options,
            ir,
        });
}
