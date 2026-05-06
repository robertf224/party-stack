import type { BlobMetadataAdapter, BlobRef, BlobState } from "../types.js";

export interface IndexedDBBlobMetadataAdapterOptions {
    databaseName?: string;
    storeName?: string;
}

export class IndexedDBBlobMetadataAdapter implements BlobMetadataAdapter {
    readonly databaseName: string;
    readonly storeName: string;
    private dbPromise?: Promise<IDBDatabase>;

    constructor(opts: IndexedDBBlobMetadataAdapterOptions = {}) {
        this.databaseName = opts.databaseName ?? "@party-stack/blobs";
        this.storeName = opts.storeName ?? "metadata";
    }

    private db(): Promise<IDBDatabase> {
        this.dbPromise ??= new Promise((resolve, reject) => {
            const request = indexedDB.open(this.databaseName, 1);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: "id" });
                    store.createIndex("state", "state");
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(toError(request.error));
        });
        return this.dbPromise;
    }

    private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        const db = await this.db();
        return db.transaction(this.storeName, mode).objectStore(this.storeName);
    }

    async put(ref: BlobRef): Promise<void> {
        const store = await this.store("readwrite");
        await requestToPromise(store.put(ref));
    }

    async get(id: string): Promise<BlobRef | undefined> {
        const store = await this.store("readonly");
        return requestToPromise(store.get(id) as IDBRequest<BlobRef | undefined>);
    }

    async list(opts?: { state?: BlobState }): Promise<BlobRef[]> {
        const store = await this.store("readonly");
        if (opts?.state) {
            return requestToPromise(store.index("state").getAll(opts.state) as IDBRequest<BlobRef[]>);
        }
        return requestToPromise(store.getAll() as IDBRequest<BlobRef[]>);
    }

    async delete(id: string): Promise<void> {
        const store = await this.store("readwrite");
        await requestToPromise(store.delete(id));
    }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(toError(request.error));
    });
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
