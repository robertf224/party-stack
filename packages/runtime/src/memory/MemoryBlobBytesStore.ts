import type { BlobBytesStore } from "../types.js";

export class MemoryBlobBytesStore implements BlobBytesStore {
    constructor(readonly blobs = new Map<string, Blob>()) {}

    write(id: string, blob: Blob): Promise<void> {
        this.blobs.set(id, blob);
        return Promise.resolve();
    }

    read(id: string): Promise<Blob> {
        const blob = this.blobs.get(id);
        return blob
            ? Promise.resolve(blob)
            : Promise.reject(new Error(`Blob bytes not found for "${id}".`));
    }

    delete(id: string): Promise<void> {
        this.blobs.delete(id);
        return Promise.resolve();
    }
}
