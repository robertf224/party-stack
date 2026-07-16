import type { BlobMetadataAdapter, BlobRef, BlobState } from "../types.js";

export class InMemoryBlobMetadataAdapter implements BlobMetadataAdapter {
    readonly refs = new Map<string, BlobRef>();
    readonly localIdByRemoteId = new Map<string, string>();

    put(ref: BlobRef): Promise<void> {
        const existing = this.refs.get(ref.id);
        if (existing?.remoteId) {
            this.localIdByRemoteId.delete(existing.remoteId);
        }
        this.refs.set(ref.id, { ...ref });
        if (ref.remoteId) {
            this.localIdByRemoteId.set(ref.remoteId, ref.id);
        }
        return Promise.resolve();
    }

    get(id: string): Promise<BlobRef | undefined> {
        const ref = this.refs.get(id);
        return Promise.resolve(ref ? { ...ref } : undefined);
    }

    getByRemoteId(remoteId: string): Promise<BlobRef | undefined> {
        const localId = this.localIdByRemoteId.get(remoteId);
        const ref = localId ? this.refs.get(localId) : undefined;
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
        const existing = this.refs.get(id);
        if (existing?.remoteId) {
            this.localIdByRemoteId.delete(existing.remoteId);
        }
        this.refs.delete(id);
        return Promise.resolve();
    }
}
