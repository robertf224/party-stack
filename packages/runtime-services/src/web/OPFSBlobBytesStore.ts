import type { BlobBytesStore } from "../types.js";

export interface OPFSBlobBytesStoreOptions {
    directoryName: string;
}

function encodeFileName(id: string): string {
    return encodeURIComponent(id);
}

function decodeFileName(name: string): string {
    return decodeURIComponent(name);
}

export class OPFSBlobBytesStore implements BlobBytesStore {
    #directoryName: string;

    constructor(options: OPFSBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async write(id: string, blob: Blob): Promise<void> {
        const directory = await this.#directory();
        const fileHandle = await directory.getFileHandle(encodeFileName(id), {
            create: true,
        });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(blob);
        } finally {
            await writable.close();
        }
    }

    async read(id: string): Promise<Blob> {
        const directory = await this.#directory();
        const fileHandle = await directory.getFileHandle(encodeFileName(id));
        return fileHandle.getFile();
    }

    async delete(id: string): Promise<void> {
        const directory = await this.#directory();
        try {
            await directory.removeEntry(encodeFileName(id));
        } catch (error) {
            if (error instanceof DOMException && error.name === "NotFoundError") {
                return;
            }
            throw error;
        }
    }

    async list(): Promise<string[]> {
        const directory = await this.#directory();
        const ids: string[] = [];
        const iterable = directory as FileSystemDirectoryHandle & AsyncIterable<[string, FileSystemHandle]>;
        for await (const [name, handle] of iterable) {
            if (handle.kind === "file") {
                ids.push(decodeFileName(name));
            }
        }
        return ids;
    }

    async #directory(): Promise<FileSystemDirectoryHandle> {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(this.#directoryName, { create: true });
    }
}
