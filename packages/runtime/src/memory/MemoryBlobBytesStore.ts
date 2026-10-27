import { collectByteBlob, type ByteInput } from "@party-stack/ontology-storage/blobs";
import { Effect } from "effect";
import { BlobBytesNotFoundError } from "../BlobBytesNotFoundError.js";
import type { BlobBytesStore } from "../types.js";

export class MemoryBlobBytesStore implements BlobBytesStore {
    constructor(readonly blobs = new Map<string, Blob>()) {}

    async write(id: string, value: ByteInput, signal?: AbortSignal): Promise<void> {
        const blob = await Effect.runPromise(collectByteBlob(value), { signal });
        this.blobs.set(id, blob);
    }

    read(id: string): Promise<Blob> {
        const blob = this.blobs.get(id);
        return blob ? Promise.resolve(blob) : Promise.reject(new BlobBytesNotFoundError(id));
    }

    delete(id: string): Promise<void> {
        this.blobs.delete(id);
        return Promise.resolve();
    }
}
