import type { BlobBytesAdapter, BlobMetadataAdapter, BlobRef, BlobState } from "../types.js";

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

export class InMemoryBlobMetadataAdapter implements BlobMetadataAdapter {
    readonly refs = new Map<string, BlobRef>();

    put(ref: BlobRef): Promise<void> {
        this.refs.set(ref.id, { ...ref });
        return Promise.resolve();
    }

    get(id: string): Promise<BlobRef | undefined> {
        const ref = this.refs.get(id);
        return Promise.resolve(ref ? { ...ref } : undefined);
    }

    list(opts?: { state?: BlobState }): Promise<BlobRef[]> {
        return Promise.resolve(
            Array.from(this.refs.values())
                .filter((ref) => !opts?.state || ref.state === opts.state)
                .map((ref) => ({ ...ref }))
        );
    }

    delete(id: string): Promise<void> {
        this.refs.delete(id);
        return Promise.resolve();
    }
}
