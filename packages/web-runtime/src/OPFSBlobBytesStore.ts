import {
    BlobBytesNotFoundError,
    byteSource,
    type ByteInput,
    type BlobBytesStore,
} from "@party-stack/runtime";
import { Stream } from "effect";

export interface OPFSBlobBytesStoreOptions {
    directoryName: string;
}

function encodeFileName(id: string): string {
    return encodeURIComponent(id);
}

export class OPFSBlobBytesStore implements BlobBytesStore {
    #directoryName: string;

    constructor(options: OPFSBlobBytesStoreOptions) {
        this.#directoryName = options.directoryName;
    }

    async write(id: string, input: ByteInput, signal?: AbortSignal): Promise<void> {
        const directory = await this.#directory();
        const fileHandle = await directory.getFileHandle(encodeFileName(id), {
            create: true,
        });
        const writable = await fileHandle.createWritable();
        await Stream.toReadableStream(byteSource(input).stream).pipeTo(writable, { signal });
    }

    async read(id: string): Promise<Blob> {
        try {
            const directory = await this.#directory();
            const fileHandle = await directory.getFileHandle(encodeFileName(id));
            return await fileHandle.getFile();
        } catch (cause) {
            if (cause instanceof DOMException && cause.name === "NotFoundError")
                throw new BlobBytesNotFoundError(id, { cause });
            throw cause;
        }
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

    async clear(): Promise<void> {
        const root = await navigator.storage.getDirectory();
        try {
            await root.removeEntry(this.#directoryName, {
                recursive: true,
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === "NotFoundError") {
                return;
            }
            throw error;
        }
    }

    async #directory(): Promise<FileSystemDirectoryHandle> {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(this.#directoryName, { create: true });
    }
}
