import { BlobRef, LocalBlobStorageAdapter } from "../types.js";

export class OPFSLocalBlobStorageAdapter implements LocalBlobStorageAdapter {
    async stage(blob: Blob, id: string): Promise<BlobRef> {
        const root = await navigator.storage.getDirectory();
        // TODO: need to see if this actually works.
        const directoryHandle = await root.getDirectoryHandle("@party-stack/blobs", { create: true });
        const fileHandle = await directoryHandle.getFileHandle(id, { create: true });
        const writable = await fileHandle.createWritable({});
        await writable.write(blob);
    }

    // complete/commit: move to persisted folder or delete?

    async get(id: string): Promise<BlobRef> {
        const root = await navigator.storage.getDirectory();
        // TODO: need to see if this actually works.
        const directoryHandle = await root.getDirectoryHandle("@party-stack/blobs", { create: true });
        const fileHandle = await directoryHandle.getFileHandle(id);
        const file = await fileHandle.getFile();
    }
}

//
