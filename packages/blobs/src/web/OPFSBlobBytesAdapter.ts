import type { BlobBytesAdapter } from "../types.js";

export interface OPFSBlobBytesAdapterOptions {
    directoryName?: string;
}

export class OPFSBlobBytesAdapter implements BlobBytesAdapter {
    readonly directoryName: string;

    constructor(opts: OPFSBlobBytesAdapterOptions = {}) {
        this.directoryName = opts.directoryName ?? "party-stack-blobs";
    }

    private async directory(): Promise<FileSystemDirectoryHandle> {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(this.directoryName, { create: true });
    }

    async write(id: string, blob: Blob): Promise<void> {
        const directory = await this.directory();
        const fileHandle = await directory.getFileHandle(id, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(blob);
        } finally {
            await writable.close();
        }
    }

    async read(id: string): Promise<Blob> {
        const directory = await this.directory();
        const fileHandle = await directory.getFileHandle(id);
        return fileHandle.getFile();
    }

    async delete(id: string): Promise<void> {
        const directory = await this.directory();
        await directory.removeEntry(id).catch((error: unknown) => {
            if (error instanceof DOMException && error.name === "NotFoundError") {
                return;
            }
            throw error;
        });
    }

    async list(): Promise<string[]> {
        const directory = await this.directory();
        const ids: string[] = [];
        const iterableDirectory = directory as FileSystemDirectoryHandle &
            AsyncIterable<[string, FileSystemHandle]>;
        for await (const [name] of iterableDirectory) {
            ids.push(name);
        }
        return ids;
    }
}
