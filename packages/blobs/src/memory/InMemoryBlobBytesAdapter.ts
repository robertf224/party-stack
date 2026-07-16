import type { BlobBytesAdapter } from "../types.js";

export class InMemoryBlobBytesAdapter implements BlobBytesAdapter {
    readonly blobs = new Map<string, Blob>();

    write(id: string, blob: Blob): Promise<void> {
        this.blobs.set(id, blob);
        return Promise.resolve();
    }

    read(id: string): Promise<Blob> {
        const blob = this.blobs.get(id);
        if (!blob) {
            return Promise.reject(new Error(`Blob bytes not found for "${id}".`));
        }
        return Promise.resolve(blob);
    }

    delete(id: string): Promise<void> {
        this.blobs.delete(id);
        return Promise.resolve();
    }

    list(): Promise<string[]> {
        return Promise.resolve(Array.from(this.blobs.keys()));
    }
}
